import { Injectable, BadRequestException } from '@nestjs/common';
import { AggregatorManagerService } from '../aggregation/aggregator-manager.service';
import { PriceImpactValidatorService } from '../../validation/price-impact-validator.service';
import {
  SwapRequest,
  SwapQuote,
  AggregatorType,
  ApprovalStrategy,
} from '@swap/models/swap-request.model';
import {
  ChainListService,
  EnhancedChainInfo,
} from '@shared/services/chainlist.service';
import {
  validateChainId,
  validateTokenAddress,
  validateWalletAddress,
  validateAmount,
  validateSlippage,
  validateDeadline,
} from '@shared/utils/validation.utils';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Quote service for getting swap quotes from aggregators
 */
@Injectable()
export class QuoteService {
  constructor(
    private readonly aggregatorManager: AggregatorManagerService,
    private readonly chainListService: ChainListService,
    private readonly winstonLogger: WinstonLoggerService,
    private readonly priceImpactValidator: PriceImpactValidatorService,
  ) {
    this.winstonLogger.setContext('QuoteService');
  }

  /**
   * Get swap quote
   */
  async getQuote(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    taker: string,
    recipient?: string,
    slippagePercentage?: number,
    deadline?: number,
    aggregatorType?: AggregatorType,
    approvalStrategy?: ApprovalStrategy,
    strictValidation?: boolean,
  ): Promise<SwapQuote> {
    const startTime = Date.now();

    try {
      // Audit log quote request
      this.winstonLogger.audit('QUOTE_REQUEST', {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        aggregatorType: aggregatorType || 'auto',
        approvalStrategy: approvalStrategy || 'default',
        strictValidation: strictValidation !== false,
        timestamp: new Date().toISOString(),
      });

      // Validate inputs
      this.validateQuoteInputs(
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        slippagePercentage,
        deadline,
      );

      // Build swap request
      const swapRequest: SwapRequest = {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        recipient: recipient || taker, // Ensure funds go back to same wallet
        slippagePercentage,
        deadline,
        aggregator: aggregatorType,
        approvalStrategy, // Include approval strategy
      };

      // Get quote from aggregator
      const quote = await this.aggregatorManager.getQuote(
        swapRequest,
        aggregatorType,
        strictValidation,
      );

      // Validate price impact
      const priceImpactValidation = this.priceImpactValidator.validate(
        quote.priceImpact,
        quote.aggregator,
      );

      // If price impact is critical, block the quote
      if (priceImpactValidation.shouldBlock) {
        this.winstonLogger.warn(
          `Quote blocked due to critical price impact: ${priceImpactValidation.priceImpactPercent}%`,
          {
            chainId,
            aggregator: quote.aggregator,
            priceImpact: quote.priceImpact,
            threshold: priceImpactValidation.threshold,
          },
        );

        throw new BadRequestException(priceImpactValidation.warning);
      }

      // Log warnings for high/medium price impact
      if (priceImpactValidation.warning) {
        this.winstonLogger.warn(
          `Price impact warning: ${priceImpactValidation.warning}`,
          {
            chainId,
            aggregator: quote.aggregator,
            severity: priceImpactValidation.severity,
          },
        );
      }

      const duration = Date.now() - startTime;

      // Audit log successful quote
      this.winstonLogger.audit('QUOTE_SUCCESS', {
        chainId,
        sellToken,
        buyToken,
        sellAmount: quote.sellAmount,
        buyAmount: quote.buyAmount,
        aggregator: quote.aggregator || aggregatorType,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.log(
        `Quote obtained: ${quote.sellAmount} ${quote.sellToken} -> ${quote.buyAmount} ${quote.buyToken}${strictValidation === false ? ' (relaxed validation)' : ''}`,
      );

      return quote;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log failed quote
      this.winstonLogger.audit('QUOTE_FAILED', {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        aggregatorType: aggregatorType || 'auto',
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to get quote: ${error.message}`,
        error.stack,
      );

      // If it's a validation error (from our validation functions), throw BadRequestException
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      // For other errors, throw a generic error
      throw new Error(`Failed to get quote: ${error.message}`);
    }
  }

  /**
   * Get quotes from all supported aggregators
   */
  async getMultipleQuotes(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    taker: string,
    recipient?: string,
    slippagePercentage?: number,
    deadline?: number,
  ): Promise<Array<{ aggregator: AggregatorType; quote: SwapQuote }>> {
    try {
      // Validate inputs
      this.validateQuoteInputs(
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        slippagePercentage,
        deadline,
      );

      // Get all supported aggregators for this chain
      const supportedAggregators = this.getSupportedAggregators(chainId);

      if (supportedAggregators.length === 0) {
        throw new Error(`No supported aggregators found for chain ${chainId}`);
      }

      this.winstonLogger.log(
        `Fetching quotes from ${supportedAggregators.length} aggregators: ${supportedAggregators.join(', ')}`,
      );

      // Fetch quotes from all supported aggregators in parallel
      const quotePromises = supportedAggregators.map(async (aggregatorType) => {
        try {
          const quote = await this.getQuote(
            chainId,
            sellToken,
            buyToken,
            sellAmount,
            taker,
            recipient,
            slippagePercentage,
            deadline,
            aggregatorType,
            undefined, // Use default approval strategy
            false, // Use relaxed validation for quote comparison
          );

          this.winstonLogger.debug(
            `Successfully got quote from ${aggregatorType}: ${quote.buyAmount} ${quote.buyToken}`,
          );

          return { aggregator: aggregatorType, quote };
        } catch (error) {
          this.winstonLogger.warn(
            `Failed to get quote from ${aggregatorType}: ${error.message}`,
          );
          // Return null for failed quotes, we'll filter them out
          return null;
        }
      });

      // Wait for all quotes and filter out failed ones
      const results = await Promise.all(quotePromises);
      const successfulQuotes = results.filter(
        (result): result is { aggregator: AggregatorType; quote: SwapQuote } =>
          result !== null,
      );

      if (successfulQuotes.length === 0) {
        throw new Error('Failed to get quotes from any aggregator');
      }

      // Filter out quotes with critical price impact
      const { validQuotes, invalidQuotes } =
        this.priceImpactValidator.validateAndFilterQuotes(
          successfulQuotes,
          (result) => result.quote.priceImpact,
        );

      // Log filtered quotes
      if (invalidQuotes.length > 0) {
        this.winstonLogger.warn(
          `Filtered out ${invalidQuotes.length} quotes due to critical price impact`,
          {
            invalidQuotes: invalidQuotes.map((item) => ({
              aggregator: item.quote.aggregator,
              priceImpact: item.quote.quote.priceImpact,
              reason: item.reason,
            })),
          },
        );
      }

      // Use valid quotes or fall back to all if validation disabled
      const finalQuotes = validQuotes.length > 0 ? validQuotes : successfulQuotes;

      this.winstonLogger.log(
        `Successfully retrieved ${finalQuotes.length} valid quotes from aggregators`,
      );

      return finalQuotes;
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get multiple quotes: ${error.message}`,
        error.stack,
      );

      // If it's a validation error, throw BadRequestException
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      throw new Error(`Failed to get multiple quotes: ${error.message}`);
    }
  }

  /**
   * Get best quote from all supported aggregators
   */
  async getBestQuote(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    taker: string,
    recipient?: string,
    slippagePercentage?: number,
    deadline?: number,
  ): Promise<{ aggregator: AggregatorType; quote: SwapQuote }> {
    try {
      const quotes = await this.getMultipleQuotes(
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        recipient,
        slippagePercentage,
        deadline,
      );

      if (quotes.length === 0) {
        throw new Error('No quotes available from any aggregator');
      }

      // Find the quote with the highest buyAmount (best output)
      const bestQuote = quotes.reduce((best, current) => {
        const bestBuyAmount = BigInt(best.quote.buyAmount);
        const currentBuyAmount = BigInt(current.quote.buyAmount);

        return currentBuyAmount > bestBuyAmount ? current : best;
      });

      // Audit log best quote selection
      this.winstonLogger.audit('BEST_QUOTE_SELECTED', {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        bestAggregator: bestQuote.aggregator,
        bestBuyAmount: bestQuote.quote.buyAmount,
        totalQuotesCompared: quotes.length,
        allAggregators: quotes.map((q) => q.aggregator),
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.log(
        `Best quote from ${bestQuote.aggregator}: ${bestQuote.quote.buyAmount} tokens (out of ${quotes.length} quotes)`,
      );

      return bestQuote;
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get best quote: ${error.message}`,
        error.stack,
      );

      // If it's a validation error, throw BadRequestException
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      throw new Error(`Failed to get best quote: ${error.message}`);
    }
  }

  /**
   * Compare quotes from all supported aggregators
   */
  async compareQuotes(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    taker: string,
    recipient?: string,
    slippagePercentage?: number,
    deadline?: number,
  ): Promise<{
    quotes: Array<{ aggregator: AggregatorType; quote: SwapQuote }>;
    bestAggregator: AggregatorType;
    priceDifference: string;
  }> {
    try {
      const quotes = await this.getMultipleQuotes(
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        recipient,
        slippagePercentage,
        deadline,
      );

      if (quotes.length === 0) {
        throw new Error('No quotes available for comparison');
      }

      if (quotes.length === 1) {
        // Only one quote available
        return {
          quotes,
          bestAggregator: quotes[0].aggregator,
          priceDifference: '0',
        };
      }

      // Find best and worst quotes for comparison
      const sortedQuotes = [...quotes].sort((a, b) => {
        const aBuyAmount = BigInt(a.quote.buyAmount);
        const bBuyAmount = BigInt(b.quote.buyAmount);
        return bBuyAmount > aBuyAmount ? 1 : bBuyAmount < aBuyAmount ? -1 : 0;
      });

      const bestQuote = sortedQuotes[0];
      const worstQuote = sortedQuotes[sortedQuotes.length - 1];

      // Calculate percentage difference between best and worst
      const bestBuyAmount = BigInt(bestQuote.quote.buyAmount);
      const worstBuyAmount = BigInt(worstQuote.quote.buyAmount);

      const difference = bestBuyAmount - worstBuyAmount;
      const priceDifferencePercent =
        worstBuyAmount > 0n
          ? (Number((difference * 10000n) / worstBuyAmount) / 100).toFixed(2)
          : '0';

      // Audit log quote comparison
      this.winstonLogger.audit('QUOTE_COMPARISON', {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        totalQuotes: quotes.length,
        bestAggregator: bestQuote.aggregator,
        bestBuyAmount: bestQuote.quote.buyAmount,
        worstAggregator: worstQuote.aggregator,
        worstBuyAmount: worstQuote.quote.buyAmount,
        priceDifferencePercent,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.log(
        `Quote comparison: Best ${bestQuote.aggregator} (${bestQuote.quote.buyAmount}), ` +
          `Worst ${worstQuote.aggregator} (${worstQuote.quote.buyAmount}), ` +
          `Difference: ${priceDifferencePercent}%`,
      );

      return {
        quotes,
        bestAggregator: bestQuote.aggregator,
        priceDifference: priceDifferencePercent,
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to compare quotes: ${error.message}`,
        error.stack,
      );

      // If it's a validation error, throw BadRequestException
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      throw new Error(`Failed to compare quotes: ${error.message}`);
    }
  }

  /**
   * Validate quote inputs
   */
  private validateQuoteInputs(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    taker: string,
    slippagePercentage?: number,
    deadline?: number,
  ): void {
    validateChainId(chainId);
    validateTokenAddress(sellToken);
    validateTokenAddress(buyToken);
    validateWalletAddress(taker);
    validateAmount(sellAmount);

    if (slippagePercentage !== undefined) {
      validateSlippage(slippagePercentage);
    }

    if (deadline !== undefined) {
      validateDeadline(deadline);
    }

    if (sellToken === buyToken) {
      throw new Error('Sell token and buy token cannot be the same');
    }
  }

  /**
   * Get supported aggregators for a chain
   */
  getSupportedAggregators(chainId: number): AggregatorType[] {
    return this.aggregatorManager.getSupportedAggregators(chainId);
  }

  /**
   * Check if aggregator supports a chain
   */
  isAggregatorSupported(
    chainId: number,
    aggregatorType: AggregatorType,
  ): boolean {
    return this.aggregatorManager.isAggregatorSupported(
      chainId,
      aggregatorType,
    );
  }

  /**
   * Get price quote (indicative pricing without transaction data)
   */
  async getPrice(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    taker: string,
    recipient?: string,
    slippagePercentage?: number,
    deadline?: number,
    aggregatorType?: AggregatorType,
    approvalStrategy?: ApprovalStrategy,
  ): Promise<any> {
    try {
      // Validate inputs
      this.validateQuoteInputs(
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        slippagePercentage,
        deadline,
      );

      // Build swap request
      const swapRequest: SwapRequest = {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        recipient: recipient || taker,
        slippagePercentage,
        deadline,
        aggregator: aggregatorType,
        approvalStrategy,
      };

      // Get price from aggregator
      const price = await this.aggregatorManager.getPrice(
        swapRequest,
        aggregatorType,
        approvalStrategy,
      );

      this.winstonLogger.log(
        `Price obtained: ${price.sellAmount} ${price.sellToken} -> ${price.buyAmount} ${price.buyToken}`,
      );

      return price;
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get price: ${error.message}`,
        error.stack,
      );

      // If it's a validation error, throw BadRequestException
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      throw new Error(`Failed to get price: ${error.message}`);
    }
  }

  /**
   * Check if an error is a validation error (should return 400 status)
   */
  private isValidationError(error: any): boolean {
    const validationErrorMessages = [
      'Invalid chain ID',
      'Invalid token address',
      'Invalid wallet address',
      'Invalid amount',
      'Invalid slippage',
      'Deadline must be',
      'Sell token and buy token cannot be the same',
    ];

    return validationErrorMessages.some((msg) => error?.message?.includes(msg));
  }

  /**
   * Get supported chains from all aggregators
   */
  async getSupportedChains(): Promise<{
    supportedChains: EnhancedChainInfo[];
    aggregatorChains: Record<string, EnhancedChainInfo[]>;
  }> {
    try {
      this.winstonLogger.log(
        'Fetching supported chains from all aggregators...',
      );

      // Get all aggregators
      const aggregators = this.aggregatorManager.getAllAggregators();

      // Fetch supported chains from each aggregator
      const aggregatorResults = await Promise.allSettled(
        aggregators.map(async (aggregator) => {
          try {
            const chains = await aggregator.getSupportedChains();
            return {
              name: aggregator.constructor.name.replace('Service', ''),
              chains: chains.sort((a, b) => a - b), // Sort numerically
            };
          } catch (error) {
            this.winstonLogger.warn(
              `Failed to get supported chains from ${aggregator.constructor.name}: ${error.message}`,
            );
            return {
              name: aggregator.constructor.name.replace('Service', ''),
              chains: [] as number[],
            };
          }
        }),
      );

      // Process results and collect all unique chain IDs
      const aggregatorChainIds: Record<string, number[]> = {};
      const allChains = new Set<number>();

      aggregatorResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          const { name, chains } = result.value;
          aggregatorChainIds[name] = chains;
          chains.forEach((chainId) => allChains.add(chainId));
        }
      });

      // Convert set to sorted array
      const supportedChainIds = Array.from(allChains).sort((a, b) => a - b);

      this.winstonLogger.log(
        `Successfully retrieved ${supportedChainIds.length} unique supported chains from ${Object.keys(aggregatorChainIds).length} aggregators`,
      );
      this.winstonLogger.debug(
        `Supported chain IDs: ${supportedChainIds.join(', ')}`,
      );

      // Fetch enhanced chain information from ChainList API
      this.winstonLogger.debug(
        'Fetching enhanced chain information from ChainList...',
      );
      const supportedChains =
        await this.chainListService.getChainInfo(supportedChainIds);

      // Create aggregator chains with enhanced info
      const aggregatorChains: Record<string, EnhancedChainInfo[]> = {};
      for (const [aggregatorName, chainIds] of Object.entries(
        aggregatorChainIds,
      )) {
        aggregatorChains[aggregatorName] =
          await this.chainListService.getChainInfo(chainIds);
      }

      this.winstonLogger.log(
        `Successfully enhanced ${supportedChains.length} chains with ChainList data`,
      );

      return {
        supportedChains,
        aggregatorChains,
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get supported chains from aggregators: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get supported chains: ${error.message}`);
    }
  }
}
