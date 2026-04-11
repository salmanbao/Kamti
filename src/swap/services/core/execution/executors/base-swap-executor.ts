import { BadRequestException } from '@nestjs/common';
import {
  ISwapExecutor,
  ExecutionContext,
  ExecutionResult,
  AmountAdjustment,
} from '../ports/swap-executor.interface';
import { RouteQuote } from '@swap/models/ports';
import { isNativeToken } from '@shared/utils/chain.utils';
import { GasEstimationService } from '../gas/gas-estimation.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { EcosystemFeeCalculatorFactory } from '../fee-calculators/ecosystem-fee-calculator.factory';

/**
 * Abstract base class for swap executors implementing Template Method Pattern
 * Defines the skeleton of the execution algorithm while letting subclasses override specific steps
 */
export abstract class BaseSwapExecutor implements ISwapExecutor {
  protected readonly logger: WinstonLoggerService;
  protected readonly gasEstimationService?: GasEstimationService;
  protected readonly feeCalculatorFactory?: EcosystemFeeCalculatorFactory;

  constructor(
    winstonLogger: WinstonLoggerService,
    loggerContext: string,
    gasEstimationService?: GasEstimationService,
    feeCalculatorFactory?: EcosystemFeeCalculatorFactory,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(loggerContext);
    this.gasEstimationService = gasEstimationService;
    this.feeCalculatorFactory = feeCalculatorFactory;
  }

  /**
   * Template method defining the execution algorithm
   * Final to prevent overriding - subclasses should override specific steps instead
   */
  abstract getName(): string;
  abstract canExecute(route: RouteQuote): boolean;

  /**
   * Default validation implementation
   * Subclasses can override to add specific validations
   *
   * Note: Balance and approval checks are removed from base validation as they are
   * handled dynamically by executors in their preExecute() phase. Each executor
   * checks balances and performs approvals as needed before building transactions.
   */
  async validate(context: ExecutionContext): Promise<string[]> {
    const errors: string[] = [];

    try {
      // Route validation
      if (!context.request.route) {
        errors.push('Route not found');
      }

      // Slippage validation
      if (!context.validations.slippageAcceptable) {
        errors.push('Slippage tolerance exceeded');
      }

      // Provider health validation
      if (!context.validations.providerHealthy) {
        errors.push('Provider is unhealthy');
      }

      // Subclass-specific validations (quote expiry, liquidity, etc.)
      const specificErrors = await this.validateSpecific(context);
      errors.push(...specificErrors);

      if (errors.length > 0) {
        this.logger.warn(
          `Validation failed for ${this.getName()}: ${errors.join(', ')}`,
        );
      } else {
        this.logger.debug(`✅ Validation passed for ${this.getName()}`);
      }

      return errors;
    } catch (error) {
      this.logger.error(`Validation error: ${error.message}`, error.stack);
      errors.push(`Validation error: ${error.message}`);
      return errors;
    }
  }

  /**
   * Main execution flow - Template Method
   * Orchestrates the execution process with proper error handling
   *
   * IMPORTANT: This method passes the same context object through all steps.
   * Modifications made in preExecute() (e.g., route updates, amount adjustments)
   * are automatically available in subsequent steps (buildTransaction, etc.)
   * because JavaScript objects are passed by reference.
   */
  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    context.executionStartTime = new Date();

    try {
      this.logger.log(`Starting ${this.getName()} execution`, {
        routeId: context.request.routeId,
        userWallet: context.request.userWallet,
        recipient: context.request.recipient,
      });

      // Step 1: Pre-execution setup
      // NOTE: preExecute() may mutate context.request.route and set context.request.amountAdjustment
      // These modifications are automatically available in subsequent steps
      this.logger.debug('Executing pre-execution setup');
      await this.preExecute(context);
      this.logger.debug('Pre-execution setup completed successfully');

      // Step 2: Build transaction data
      // NOTE: Uses the same context object, so any modifications from preExecute() are available here
      this.logger.debug('Building transaction data');
      const txData = await this.buildTransaction(context);

      this.logger.debug('Transaction data built successfully', {
        to: txData.to,
        value: txData.value,
        dataLength: txData.data?.length || 0,
        hasGasLimit: !!txData.gasLimit,
      });

      // Step 3: Execute transaction
      this.logger.log('Sending transaction to blockchain');
      const txHash = await this.sendTransaction(txData, context);
      this.logger.log('Transaction sent successfully', {
        transactionHash: txHash,
        executor: this.getName(),
      });

      // Step 4: Wait for confirmation
      const chainId = this.getChainIdFromRoute(context.request.route);
      const requiredConfirmations = this.getRequiredConfirmations(chainId);
      this.logger.log(`Waiting for transaction confirmation`, {
        transactionHash: txHash,
        chainId,
        requiredConfirmations,
      });
      const receipt = await this.waitForConfirmation(
        txHash,
        chainId,
        requiredConfirmations,
      );
      this.logger.log('Transaction confirmed', {
        transactionHash: txHash,
        blockNumber: receipt.blockNumber,
        status: receipt.status,
        chainId,
      });

      // Step 5: Post-execution cleanup
      this.logger.debug('Executing post-execution cleanup');
      await this.postExecute(context, txHash, receipt);

      const executionTime = Date.now() - startTime;
      this.logger.log(`Execution completed successfully`, {
        executionTimeMs: executionTime,
        transactionHash: txHash,
        executor: this.getName(),
      });

      // Parse receipt status - different chains return different formats
      const txStatus = this.parseReceiptStatus(receipt.status);

      // Generate appropriate explorer URLs for the transaction
      const route = context.request.route;
      const isCrossChain = this.isCrossChainSwap(route);

      // For cross-chain swaps: provide both source chain explorer AND provider tracking URL
      // For on-chain swaps: provide only source chain explorer
      const sourceChainExplorerUrl = this.getExplorerUrl(chainId, txHash);
      const providerTrackingUrl = isCrossChain
        ? this.getProviderTrackingUrl(route, txHash)
        : undefined;

      // CRITICAL: Set success based on actual transaction status, not hardcoded to true
      // A transaction can be confirmed but still fail (revert), so we must check txStatus
      const isSuccess = txStatus === 'SUCCESS';

      const baseResult: ExecutionResult = {
        success: isSuccess,
        transactionHash: txHash,
        chainId,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed?.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
        status: txStatus,
        // Add error message if transaction failed
        error: !isSuccess
          ? `Transaction reverted or failed (status: ${receipt.status})`
          : undefined,
        explorerUrl: sourceChainExplorerUrl, // ALWAYS source chain explorer (Etherscan, BSCScan, etc.)
        bridgeStatusUrl: providerTrackingUrl, // Provider-specific tracking URL (LiFi, Socket, Rubic, etc.)
        timestamp: new Date(),
      };

      // Allow subclasses to enrich the result (e.g., cross-chain bridge tracking)
      return this.augmentExecutionResult(context, baseResult, receipt);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const chainId = this.getChainIdFromRoute(context.request.route);

      this.logger.error(`Execution failed after ${executionTime}ms`, {
        error: error.message,
        executor: this.getName(),
        routeId: context.request.routeId,
        chainId,
        executionTimeMs: executionTime,
        stack: error.stack,
      });

      return {
        success: false,
        transactionHash: '',
        chainId,
        status: 'FAILED',
        error: error.message,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Hook to let subclasses enrich the execution result with additional context
   * Default: no-op passthrough
   */
  protected augmentExecutionResult(
    _context: ExecutionContext,
    result: ExecutionResult,
    _receipt: any,
  ): ExecutionResult {
    return result;
  }

  /**
   * Helper method to extract chainId from route
   */
  protected getChainIdFromRoute(route: RouteQuote): number | string {
    // Get chainId from first step in the route
    if (route.steps && route.steps.length > 0) {
      return route.steps[0].chainId;
    }
    throw new Error('Cannot determine chainId from route');
  }

  /**
   * Abstract methods to be implemented by subclasses
   */

  /**
   * Subclass-specific validation logic
   */
  protected abstract validateSpecific(
    context: ExecutionContext,
  ): Promise<string[]>;

  /**
   * Estimate transaction cost (gas/compute units) for the swap
   * Returns gas limit and total cost in native token units
   */
  protected abstract estimateTransactionCost(
    context: ExecutionContext,
  ): Promise<{
    gasLimit: string;
    gasCost: string; // Total cost in wei (or equivalent for non-EVM)
  }>;

  /**
   * Adjust swap amount by fetching new quote with adjusted amount
   *
   * IMPORTANT: This method MUTATES the context object:
   * - Updates context.request.route.providerRef with new quote
   * - Updates context.request.route.totalEstimatedOut with new output amount
   * - Updates context.request.route.minOutputAmount with new min output
   * - Updates context.request.route.steps if route structure changes
   * - Updates context.request.routeId (typically adds "_adjusted_" suffix)
   *
   * These mutations are automatically available to buildTransaction() because
   * JavaScript objects are passed by reference.
   *
   * @param context - Execution context (will be mutated)
   * @param adjustedAmount - The adjusted swap amount (after gas deduction)
   * @param gasCost - Estimated gas cost for logging/tracking
   */
  protected abstract adjustSwapAmount(
    context: ExecutionContext,
    adjustedAmount: string,
    gasCost: string,
  ): Promise<void>;

  /**
   * Pre-execution setup (e.g., check gas, prepare data)
   * Base implementation handles native token balance adjustment
   * Subclasses can override and call super.preExecute() first
   *
   * IMPORTANT: This method MUTATES the context object:
   * - Modifies context.request.route (updates providerRef, totalEstimatedOut, etc.)
   * - Sets context.request.amountAdjustment (if amount adjustment is performed)
   * - Updates context.request.routeId (if a new route is fetched)
   *
   * These mutations are automatically available to buildTransaction() and subsequent steps
   * because the same context object is passed by reference.
   */
  protected async preExecute(context: ExecutionContext): Promise<void> {
    const route = context.request.route;
    const swapFullBalance = context.request.swapFullBalance || false;

    // Debug log: Track swapFullBalance flag in preExecute
    if (this.logger) {
      this.logger.debug(
        '🔍 PreExecute: swapFullBalance flag - ' +
          JSON.stringify({
            rawValue: context.request.swapFullBalance,
            type: typeof context.request.swapFullBalance,
            normalizedValue: swapFullBalance,
          }),
      );
    }

    // Extract sell token address from route
    const swapQuote = route.providerRef as any;
    const sellTokenAddress =
      swapQuote?.sellToken || swapQuote?.sellTokenAddress;

    // CRITICAL DEBUG: Log swapQuote structure to diagnose why amount adjustment is skipped
    if (this.logger) {
      this.logger.log(
        '🔍 PreExecute: SwapQuote structure analysis',
        JSON.stringify({
          hasSellToken: !!swapQuote?.sellToken,
          sellTokenValue: swapQuote?.sellToken,
          hasSellTokenAddress: !!swapQuote?.sellTokenAddress,
          sellTokenAddressValue: swapQuote?.sellTokenAddress,
          extractedSellTokenAddress: sellTokenAddress,
          aggregator: swapQuote?.aggregator,
          swapType: swapQuote?.swapType,
          routeSteps: route.steps?.length,
          firstStepFromToken: route.steps?.[0]?.details?.fromToken,
        }),
      );
    }

    if (!sellTokenAddress) {
      if (this.logger) {
        this.logger.log(
          '⚠️ No sell token address found in route, skipping native token adjustment',
          JSON.stringify({
            swapQuoteKeys: swapQuote ? Object.keys(swapQuote).slice(0, 20) : [],
            routeKeys: route ? Object.keys(route).slice(0, 10) : [],
          }),
        );
      }
      return;
    }

    // Only process native token swaps
    if (!isNativeToken(sellTokenAddress)) {
      if (this.logger) {
        this.logger.log(
          '⚠️ Sell token is not native token, skipping amount adjustment',
          JSON.stringify({
            sellTokenAddress,
            sellTokenType: typeof sellTokenAddress,
            sellTokenLowerCase: String(sellTokenAddress).toLowerCase(),
            isNativeTokenResult: isNativeToken(sellTokenAddress),
          }),
        );
      }
      return;
    }

    const chainId = this.getChainIdFromRoute(route);
    const userWallet = context.request.userWallet;
    // CRITICAL: For native tokens, use sellAmount or value from quote, NOT totalEstimatedOut
    // totalEstimatedOut is the BUY amount (output), not the SELL amount (input)
    // For native tokens, value field should match sellAmount
    const requestedAmount = swapQuote?.sellAmount || swapQuote?.value || '0';

    if (this.logger) {
      this.logger.log(
        '✅ Checking native token balance for amount adjustment',
        JSON.stringify({
          chainId,
          userWallet,
          requestedAmount,
          swapFullBalance,
        }),
      );
    }

    try {
      // Get user's native token balance
      const balance = await this.getNativeTokenBalance(chainId, userWallet);
      this.logger.log('Native token balance retrieved', {
        balance,
        requestedAmount,
        difference: (BigInt(balance) - BigInt(requestedAmount)).toString(),
      });

      if (this.logger) {
        this.logger.log(
          '💰 Native token balance retrieved',
          JSON.stringify({
            balance,
            requestedAmount,
            difference: (BigInt(balance) - BigInt(requestedAmount)).toString(),
          }),
        );
      }

      // Check if adjustment is needed
      // CRITICAL: Always check gas sufficiency, even if balance >= requestedAmount
      // Edge cases:
      // 1. balance == requestedAmount: User tries to swap exactly their balance (no room for gas)
      // 2. balance slightly > requestedAmount: May not have enough for gas fees
      // 3. swapFullBalance=true: User explicitly wants to swap full balance
      const balanceBigInt = BigInt(balance);
      const requestedAmountBigInt = BigInt(requestedAmount);

      // If balance < requestedAmount or swapFullBalance, definitely need adjustment
      const needsAdjustmentDueToInsufficientBalance =
        balanceBigInt < requestedAmountBigInt;

      if (swapFullBalance || needsAdjustmentDueToInsufficientBalance) {
        // Full balance swap or insufficient balance - estimate gas and adjust
        this.logger.log(
          'Full balance swap or insufficient balance detected, estimating gas and adjusting amount',
        );

        if (this.logger) {
          this.logger.log(
            '⚡ Full balance or insufficient balance detected',
            JSON.stringify({
              swapFullBalance,
              needsAdjustmentDueToInsufficientBalance,
              balance,
              requestedAmount,
            }),
          );
        }

        let gasEstimate: { gasLimit: string; gasCost: string };

        // CRITICAL: For swapFullBalance=true, gas estimation will likely fail because:
        // 1. If requestedAmount >= balance: gas estimation tries with value = balance, leaving no room for gas
        // 2. If requestedAmount is close to balance (within 1%): gas estimation may still fail
        // Use conservative estimate from route data first, then adjust amount
        //
        // Example: User has 100 BNB, wants to swap full balance
        // - Initial quote might have sellAmount = 100 BNB (or 99.9 BNB due to fees)
        // - Gas estimation with value = 100 BNB (or 99.9 BNB) will fail
        // - Solution: Use conservative estimate from route data, then adjust amount to 99 BNB (100 - 1 BNB gas)
        const requestedAmountBigInt = BigInt(requestedAmount);
        const balanceBigInt = BigInt(balance);
        // Check if requested amount is close to balance (within 1% or >= balance)
        // This handles cases where swapFullBalance=true and requestedAmount might be slightly less than balance
        const difference =
          requestedAmountBigInt >= balanceBigInt
            ? requestedAmountBigInt - balanceBigInt
            : balanceBigInt - requestedAmountBigInt;
        const differencePercent =
          balanceBigInt > 0n
            ? (difference * BigInt(100)) / balanceBigInt
            : BigInt(0);
        const isRequestedAmountCloseToBalance =
          requestedAmountBigInt >= balanceBigInt ||
          differencePercent <= BigInt(1);

        if (swapFullBalance || isRequestedAmountCloseToBalance) {
          this.logger.log(
            'Using conservative gas estimate for full balance swap (requested amount close to balance)',
            {
              requestedAmount,
              balance,
              difference: difference.toString(),
              differencePercent: differencePercent.toString() + '%',
              swapFullBalance,
              note: 'Gas estimation with value close to balance would fail, using route data estimate first',
            },
          );

          if (this.logger) {
            this.logger.log(
              '🔧 Using conservative gas estimate',
              JSON.stringify({
                requestedAmount,
                balance,
                difference: difference.toString(),
                differencePercent: differencePercent.toString() + '%',
                swapFullBalance,
                isRequestedAmountCloseToBalance,
              }),
            );
          }

          // Get conservative estimate from route data (now async to fetch gas price from network if needed)
          gasEstimate = await this.getConservativeGasEstimateFromRoute(context);

          if (this.logger) {
            this.logger.log(
              '📊 Conservative gas estimate obtained',
              JSON.stringify({
                gasLimit: gasEstimate.gasLimit,
                gasCost: gasEstimate.gasCost,
              }),
            );
          }
        } else {
          // For insufficient balance cases (but not close to balance), try normal estimation
          // This may still fail, but estimateTransactionCost handles fallback
          gasEstimate = await this.estimateTransactionCost(context);
        }

        // CRITICAL: Capture original amount BEFORE any adjustments
        // This ensures originalAmount always refers to the user's original request, not an adjusted amount
        await this.performAmountAdjustment(
          context,
          balance,
          gasEstimate,
          requestedAmount,
        );

        if (this.logger) {
          const swapQuote = route.providerRef as any;
          this.logger.log(
            '✅ Amount adjustment completed',
            JSON.stringify({
              originalAmount: requestedAmount,
              balance,
              gasCost: gasEstimate.gasCost,
              adjustedAmount: swapQuote?.value || swapQuote?.sellAmount,
            }),
          );
        }
      } else {
        // Balance >= requestedAmount and not swapFullBalance
        // Still need to check if there's enough for gas fees
        this.logger.debug(
          'Balance meets or exceeds requested amount, checking gas sufficiency',
        );

        const gasEstimate = await this.estimateTransactionCost(context);
        const totalRequired =
          requestedAmountBigInt + BigInt(gasEstimate.gasCost);

        if (balanceBigInt < totalRequired) {
          // Edge case: balance >= requestedAmount but < (requestedAmount + gas)
          // Example: balance = 1.0 ETH, requestedAmount = 1.0 ETH, gas = 0.001 ETH
          // Solution: Adjust amount to (balance - gas)
          this.logger.log(
            'Balance insufficient for requested amount + gas, adjusting amount',
            {
              balance,
              requestedAmount,
              gasCost: gasEstimate.gasCost,
              totalRequired: totalRequired.toString(),
              scenario: 'balance >= requestedAmount but insufficient for gas',
            },
          );
          await this.performAmountAdjustment(
            context,
            balance,
            gasEstimate,
            requestedAmount,
          );
        } else {
          this.logger.debug(
            'Balance sufficient for requested amount + gas, no adjustment needed',
            {
              balance,
              requestedAmount,
              gasCost: gasEstimate.gasCost,
              totalRequired: totalRequired.toString(),
            },
          );
        }
      }
    } catch (error) {
      this.logger.warn('Error during native token balance adjustment', {
        error: error.message,
        stack: error.stack,
      });

      if (this.logger) {
        this.logger.error(
          '❌ Error during amount adjustment',
          JSON.stringify({
            error: error.message,
            stack: error.stack,
            chainId,
            userWallet,
            requestedAmount,
          }),
        );
      }

      // Don't fail execution - proceed with original amount
      // User will see transaction failure if insufficient balance
    }
  }

  /**
   * Get native token balance for a wallet
   * Abstract method to be implemented by subclasses
   */
  protected abstract getNativeTokenBalance(
    chainId: number | string,
    walletAddress: string,
  ): Promise<string>;

  /**
   * Get gas price from network (Etherscan or RPC)
   * Abstract method to be implemented by subclasses
   * Used when route/quote gas price is missing or 0
   *
   * @param chainId - Chain ID to get gas price for
   * @returns Gas price in wei (as string)
   */
  protected abstract getGasPriceFromNetwork(
    chainId: number | string,
  ): Promise<string>;

  /**
   * Get conservative gas estimate from route data
   * Used when swapFullBalance=true and requested amount >= balance to avoid gas estimation failure
   *
   * CRITICAL: For Ethereum mainnet, Rubic API returns gasPrice=0, so we fetch from network
   *
   * @param context - Execution context containing route data
   * @returns Conservative gas estimate based on route's gas limit and price
   */
  protected async getConservativeGasEstimateFromRoute(
    context: ExecutionContext,
  ): Promise<{ gasLimit: string; gasCost: string }> {
    // CRITICAL: For non-EVM chains (Tron, Solana), use estimateTransactionCost instead
    // These chains don't use gas model (gasLimit * gasPrice) and have chain-specific cost calculations
    const route = context.request.route;
    const sourceChainId = route.steps?.[0]?.chainId;

    // Convert chainId to string for comparison (handles both number and string chainIds)
    const chainIdStr = String(sourceChainId).toLowerCase();

    // Check if this is a non-EVM chain that needs special handling
    const isTron =
      chainIdStr.includes('tron') ||
      chainIdStr === '195' ||
      sourceChainId === 195;
    const isSolana =
      chainIdStr.includes('solana') || chainIdStr.includes('sol');
    const isBitcoin =
      chainIdStr.includes('bitcoin') || chainIdStr.includes('btc');

    if (isTron || isSolana || isBitcoin) {
      this.logger.log(
        'Non-EVM chain detected in getConservativeGasEstimateFromRoute, using estimateTransactionCost',
        {
          sourceChainId,
          chainType: isTron ? 'Tron' : isSolana ? 'Solana' : 'Bitcoin',
          note: 'These chains do not use EVM gas model (gasLimit * gasPrice), using chain-specific cost calculation',
        },
      );

      // Use estimateTransactionCost which has correct logic for Tron/Solana/Bitcoin
      return await this.estimateTransactionCost(context);
    }

    // For EVM chains, use gas estimation service if available
    if (this.gasEstimationService) {
      return await this.gasEstimationService.getConservativeGasEstimateFromRoute(
        context,
      );
    }

    // Fallback to original implementation (for backward compatibility)
    return await this.getConservativeGasEstimateFromRouteLegacy(context);
  }

  /**
   * Legacy implementation of getConservativeGasEstimateFromRoute
   * Kept for backward compatibility when gasEstimationService is not injected
   */
  protected async getConservativeGasEstimateFromRouteLegacy(
    context: ExecutionContext,
  ): Promise<{ gasLimit: string; gasCost: string }> {
    const route = context.request.route;
    const swapQuote = route.providerRef as any;

    // Get gas limit from route or quote
    const routeGasLimit =
      route.fees?.gas && route.fees.gas !== '0' ? route.fees.gas : undefined;
    const quoteGasLimit = swapQuote?.gas || swapQuote?.estimatedGas;

    // Use route gas limit if available, otherwise quote gas limit, otherwise conservative default
    // CRITICAL: Cross-chain swaps legitimately need 500k-700k gas, so we should NOT cap at 400k
    // Only cap obviously wrong values (like 5M+) that are likely placeholders or bugs
    // Use a more reasonable default (250000) that's closer to actual usage (~226669 from logs)
    const MAX_ABSOLUTE_GAS_LIMIT = 5000000; // Absolute maximum to prevent obviously wrong values (e.g., bugs/placeholders)
    const isCrossChain = this.isCrossChainSwap(route);
    const CONSERVATIVE_DEFAULT_GAS_LIMIT = isCrossChain ? 600000 : 250000; // 600k for bridge, 250k on-chain
    let gasLimit: string;

    if (routeGasLimit) {
      const routeGasLimitNum = parseInt(routeGasLimit);
      // Only reject if it's absurdly high (likely a bug/placeholder)
      // Cross-chain swaps legitimately need 500k-700k gas, so accept those values
      if (routeGasLimitNum > MAX_ABSOLUTE_GAS_LIMIT) {
        this.logger.warn(
          'Route gas limit exceeds absolute maximum, using conservative default',
          {
            routeGasLimit,
            maxAbsoluteGasLimit: MAX_ABSOLUTE_GAS_LIMIT,
            fallbackGasLimit: CONSERVATIVE_DEFAULT_GAS_LIMIT,
            note: 'Route gas limit is absurdly high (likely bug/placeholder), using conservative default',
          },
        );
        gasLimit = CONSERVATIVE_DEFAULT_GAS_LIMIT.toString();
      } else {
        // Use route gas limit (even if it's 500k-700k, as cross-chain swaps legitimately need that)
        gasLimit = routeGasLimit;
        this.logger.log('Using route gas limit (within acceptable range)', {
          routeGasLimit,
          note: 'Cross-chain swaps legitimately need 500k-700k gas, accepting route-provided value',
        });
      }
    } else if (quoteGasLimit) {
      const quoteGasLimitNum = parseInt(quoteGasLimit);
      // Only reject if it's absurdly high (likely a bug/placeholder)
      if (quoteGasLimitNum > MAX_ABSOLUTE_GAS_LIMIT) {
        this.logger.warn(
          'Quote gas limit exceeds absolute maximum, using conservative default',
          {
            quoteGasLimit,
            maxAbsoluteGasLimit: MAX_ABSOLUTE_GAS_LIMIT,
            fallbackGasLimit: CONSERVATIVE_DEFAULT_GAS_LIMIT,
            note: 'Quote gas limit is absurdly high (likely bug/placeholder), using conservative default',
          },
        );
        gasLimit = CONSERVATIVE_DEFAULT_GAS_LIMIT.toString();
      } else {
        // Use quote gas limit (even if it's 500k-700k, as cross-chain swaps legitimately need that)
        gasLimit = quoteGasLimit;
        this.logger.log('Using quote gas limit (within acceptable range)', {
          quoteGasLimit,
          note: 'Cross-chain swaps legitimately need 500k-700k gas, accepting quote-provided value',
        });
      }
    } else {
      gasLimit = CONSERVATIVE_DEFAULT_GAS_LIMIT.toString(); // Default based on context (600k bridge / 250k on-chain)
    }

    // CRITICAL: Always prioritize provider APIs (NodeReal -> Etherscan -> RPC -> Static) over route/quote gas prices
    // Route/quote gas prices are often static placeholders (e.g., 50 gwei from Rubic API) and don't reflect current network conditions
    // Provider APIs provide dynamic, accurate gas prices that ensure precise gas cost calculation
    const sourceChainId = route.steps?.[0]?.chainId;
    let gasPrice: string;

    try {
      // PRIORITY: Always fetch from provider APIs first (NodeReal -> Etherscan -> RPC -> Static)
      this.logger.log(
        'Fetching gas price from provider APIs (NodeReal -> Etherscan -> RPC -> Static) for precise cost calculation',
        {
          sourceChainId,
          note: 'Prioritizing dynamic provider APIs over static route/quote gas prices for accuracy',
        },
      );

      gasPrice = await this.getGasPriceFromNetwork(sourceChainId);

      this.logger.log('Successfully fetched gas price from provider APIs', {
        sourceChainId,
        gasPrice,
        source: 'provider-apis',
        priority: 'dynamic',
      });
    } catch (error) {
      this.logger.warn(
        'Failed to fetch gas price from provider APIs, checking route/quote data as fallback',
        {
          sourceChainId,
          error: error.message,
        },
      );

      // FALLBACK: Only use route/quote gas price if provider APIs fail
      // Validate route/quote gas prices are not "0" or 0
      const routeGasPriceStr = route.fees?.gasPrice?.toString();
      const routeGasPrice =
        routeGasPriceStr &&
        routeGasPriceStr !== '0' &&
        BigInt(routeGasPriceStr) > 0n
          ? routeGasPriceStr
          : undefined;

      const quoteGasPriceStr = swapQuote?.gasPrice?.toString();
      const quoteGasPrice =
        quoteGasPriceStr &&
        quoteGasPriceStr !== '0' &&
        BigInt(quoteGasPriceStr) > 0n
          ? quoteGasPriceStr
          : undefined;

      if (routeGasPrice || quoteGasPrice) {
        // Validate route/quote gas price is reasonable (not a placeholder like 50 gwei)
        const selectedRouteQuotePrice = routeGasPrice || quoteGasPrice!;
        const MAX_REASONABLE_GAS_PRICE = BigInt('25000000000'); // 25 gwei absolute maximum
        const routeQuotePriceBigInt = BigInt(selectedRouteQuotePrice);

        if (routeQuotePriceBigInt > MAX_REASONABLE_GAS_PRICE) {
          this.logger.warn(
            'Route/quote gas price exceeds maximum (25 gwei), likely a placeholder, using chain-specific default',
            {
              routeGasPrice,
              quoteGasPrice,
              selectedRouteQuotePrice,
              maxReasonableGasPrice: MAX_REASONABLE_GAS_PRICE.toString(),
              note: 'Route/quote gas price appears to be a placeholder (e.g., Rubic API 50 gwei), using chain default',
            },
          );

          // Use chain-specific defaults instead of unrealistic route/quote price
          if (sourceChainId === 1) {
            gasPrice = '30000000000'; // 30 gwei for Ethereum mainnet
          } else if (sourceChainId === 56) {
            gasPrice = '5000000000'; // 5 gwei for BSC
          } else if (sourceChainId === 137) {
            gasPrice = '50000000000'; // 50 gwei for Polygon
          } else {
            gasPrice = '20000000000'; // 20 gwei generic default
          }
        } else {
          gasPrice = selectedRouteQuotePrice;
          this.logger.log(
            'Using gas price from route/quote data as fallback (provider APIs failed)',
            {
              routeGasPrice,
              quoteGasPrice,
              selectedGasPrice: gasPrice,
              source: 'route-quote-fallback',
              note: 'Provider APIs failed, using route/quote gas price as fallback',
            },
          );
        }
      } else {
        // Route/quote gas price is missing or 0 - use chain-specific defaults
        this.logger.warn(
          'Route/quote gas price is missing or 0, using chain-specific default',
          {
            sourceChainId,
            routeGasPrice,
            quoteGasPrice,
            note: 'Both provider APIs and route/quote gas prices unavailable, using chain default',
          },
        );

        // Use chain-specific defaults as final fallback
        if (sourceChainId === 1) {
          gasPrice = '30000000000'; // 30 gwei for Ethereum mainnet
        } else if (sourceChainId === 56) {
          gasPrice = '5000000000'; // 5 gwei for BSC
        } else if (sourceChainId === 137) {
          gasPrice = '50000000000'; // 50 gwei for Polygon
        } else {
          gasPrice = '20000000000'; // 20 gwei generic default
        }
      }
    }

    // IMPORTANT: Route/quote gas limits (e.g., Rubic) already include provider safety margins.
    // Applying another margin here double-counts and artificially inflates the required balance.
    const gasLimitWithMargin = gasLimit;

    // CRITICAL: Calculate gas cost for balance validation
    // The node validates: balance >= txValue + (gasLimit * maxFeePerGas)
    // So we MUST use the FULL gas cost (gasLimitWithMargin * gasPrice) for balance calculation
    // NOT the 77% adjusted cost, because the node doesn't know about our 77% adjustment
    const fullGasCostForBalance = (
      BigInt(gasLimitWithMargin) * BigInt(gasPrice)
    ).toString();

    // Calculate 77% adjusted cost for actual usage estimation (historical data shows ~76.5% actual usage)
    // This is used for logging/analytics, but NOT for balance calculation
    const baseGasCost = BigInt(gasLimit) * BigInt(gasPrice);
    const adjustedGasCostForUsage = (
      (baseGasCost * BigInt(77)) /
      BigInt(100)
    ).toString();

    this.logger.log('Using conservative gas estimate from route data', {
      routeGasLimit,
      quoteGasLimit,
      selectedGasLimit: gasLimit,
      gasLimitWithMargin,
      gasPrice,
      baseGasCost: baseGasCost.toString(),
      fullGasCostForBalance,
      adjustedGasCostForUsage,
      costAdjustmentFactor:
        '77% (for usage estimation only, NOT for balance calculation)',
      limitMargin:
        '0% (route/quote gas limit already includes provider safety margin; no double margin applied)',
      note: 'Full gas cost used for balance calculation to match node validation. 77% adjustment used only for usage estimation.',
    });

    return {
      gasLimit: gasLimitWithMargin, // Use gas limit with 20% margin
      gasCost: fullGasCostForBalance, // Use FULL gas cost for balance calculation (node validates: balance >= txValue + gasLimit * gasPrice)
    };
  }

  /**
   * Perform amount adjustment: calculate adjusted amount and fetch new quote
   *
   * This method MUTATES the context object:
   * - Calls adjustSwapAmount() which updates context.request.route with new quote data
   * - Sets context.request.amountAdjustment with adjustment details
   * - May update context.request.routeId if a new route is fetched
   *
   * The mutations are automatically available to buildTransaction() because
   * JavaScript objects are passed by reference.
   *
   * @param context - Execution context (will be mutated)
   * @param balance - User's native token balance
   * @param gasEstimate - Gas limit and cost estimate
   */
  private async performAmountAdjustment(
    context: ExecutionContext,
    balance: string,
    gasEstimate: { gasLimit: string; gasCost: string },
    originalRequestAmount: string,
  ): Promise<void> {
    const route = context.request.route;
    const swapQuote = route.providerRef as any;
    const swapFullBalance = context.request.swapFullBalance || false;
    const originalAmount = originalRequestAmount;
    const originalOutputAmount = route.totalEstimatedOut || '0';

    // Detect ecosystem from source chain
    const sourceChainId = route.steps?.[0]?.chainId;
    const ecosystem = this.feeCalculatorFactory
      ? this.feeCalculatorFactory.detectEcosystem(sourceChainId)
      : 'evm';

    this.logger.log('🔍 Performing amount adjustment with fee calculator', {
      ecosystem,
      sourceChainId,
      balance,
      swapFullBalance,
      originalAmount: originalRequestAmount,
      gasCost: gasEstimate.gasCost,
    });

    let adjustedAmount: string;
    let reservedAmount: string = '0';
    let feeBreakdown: any = {};

    const balanceBigInt = BigInt(balance);
    const gasCostBigInt = BigInt(gasEstimate.gasCost);
    const rubicRoundingBuffer = BigInt(100);

    if (this.feeCalculatorFactory && swapFullBalance) {
      try {
        this.logger.log('✅ Using fee calculator for full-balance swap', {
          ecosystem,
          sourceChainId,
          balance,
        });

        // Detect ecosystem from chainId and get appropriate calculator
        const detectedEcosystem =
          this.feeCalculatorFactory.detectEcosystem(sourceChainId);
        const calculator =
          this.feeCalculatorFactory.getCalculator(detectedEcosystem);

        this.logger.log('Ecosystem detected for fee calculation', {
          sourceChainId,
          detectedEcosystem,
          originalEcosystem: ecosystem,
        });

        // Prepare chain-specific parameters
        const params: any = {
          chainId: sourceChainId,
          gasLimit: gasEstimate.gasLimit,
          // Use actual gas price from quote, not total gas cost
          maxFeePerGas: swapQuote?.maxFeePerGas,
          gasPrice: swapQuote?.gasPrice,
        };

        // Add ecosystem-specific parameters
        if (detectedEcosystem === 'solana') {
          // Solana: compute units and priority fees
          const gasLimitObj = swapQuote?.gasLimit
            ? JSON.parse(swapQuote.gasLimit)
            : {};
          params.walletAddress = context.request.userWallet;
          params.computeUnits = gasLimitObj.computeUnits || 400000;
          params.priorityFeeMicroLamports =
            gasLimitObj.priorityFeeMicroLamports || 1000;

          this.logger.log('Solana-specific parameters prepared', {
            walletAddress: params.walletAddress,
            computeUnits: params.computeUnits,
            priorityFeeMicroLamports: params.priorityFeeMicroLamports,
          });
        } else if (detectedEcosystem === 'bitcoin') {
          // Bitcoin: fee rate and UTXO counts
          params.feeRate = gasEstimate.gasCost || '20'; // Default 20 sat/vByte
          params.inputCount = 1; // Conservative estimate
          params.outputCount = 2; // 1 recipient + 1 change

          this.logger.log('Bitcoin-specific parameters prepared', {
            feeRate: params.feeRate,
            inputCount: params.inputCount,
            outputCount: params.outputCount,
          });
        } else if (detectedEcosystem === 'tron') {
          // Tron: energy and bandwidth costs
          const gasLimitObj = swapQuote?.gasLimit
            ? JSON.parse(swapQuote.gasLimit)
            : {};
          params.energyCost = gasLimitObj.energyCost || '50000'; // Default energy cost
          params.bandwidthCost = gasLimitObj.bandwidthCost || '50000'; // Default bandwidth cost

          this.logger.log('Tron-specific parameters prepared', {
            energyCost: params.energyCost,
            bandwidthCost: params.bandwidthCost,
          });
        } else {
          // EVM: use gasLimit, maxFeePerGas, and gasPrice from quote
          this.logger.log('EVM-specific parameters prepared', {
            gasLimit: params.gasLimit,
            maxFeePerGas: params.maxFeePerGas,
            gasPrice: params.gasPrice,
          });
        }

        // Calculate full-balance adjustment using fee calculator
        const result = await calculator.calculateFullBalanceAdjustment(
          balance,
          true, // isFullBalance
          params,
        );

        adjustedAmount = result.adjustedAmount;
        reservedAmount = result.reserved;
        feeBreakdown = result.breakdown || {};

        this.logger.log('✅ Fee calculator adjustment completed', {
          ecosystem,
          balance,
          adjustedAmount,
          reservedAmount,
          feeBreakdown,
        });
      } catch (error) {
        this.logger.warn('⚠️ Fee calculator failed, using fallback', {
          error: error.message,
          ecosystem,
        });

        const result = this.performFallbackAdjustment(
          ecosystem,
          balance,
          gasEstimate,
          originalAmount,
        );
        adjustedAmount = result.adjustedAmount;
        reservedAmount = result.reservedAmount;
      }
    } else {
      this.logger.log('Using fallback adjustment', {
        swapFullBalance,
        hasCalculator: !!this.feeCalculatorFactory,
        ecosystem,
      });

      const result = this.performFallbackAdjustment(
        ecosystem,
        balance,
        gasEstimate,
        originalAmount,
      );
      adjustedAmount = result.adjustedAmount;
      reservedAmount = result.reservedAmount;
    }

    if (!context.request.amountAdjustment) {
      context.request.amountAdjustment = {
        originalAmount,
        adjustedAmount,
        reserved: reservedAmount,
        feeBreakdown,
        gasCost: gasEstimate.gasCost,
        gasLimit: gasEstimate.gasLimit,
        reason: swapFullBalance
          ? `Full balance swap (${ecosystem})`
          : 'Insufficient balance',
        originalOutputAmount,
        adjustedOutputAmount: '0',
      };
    }

    await this.adjustSwapAmount(context, adjustedAmount, gasEstimate.gasCost);

    const MAX_REFINEMENT_ITERATIONS = 3;
    let refinementIteration = 0;
    let currentRequestedAmount = adjustedAmount;
    let lastRequestedAmount = adjustedAmount; // Track the last amount we successfully requested

    // CRITICAL: Use actual reserved amount from fee calculator (if available) for refinement checks
    // The gasEstimate.gasCost may be a conservative estimate (e.g., 1.1 TRX for Tron)
    // but the fee calculator may reserve less (e.g., 0.11 TRX for Tron actual fees)
    // Using the larger value causes false positives in refinement checks
    const actualReservedAmount = reservedAmount
      ? BigInt(reservedAmount)
      : gasCostBigInt;

    this.logger.log('Starting refinement loop with fee parameters', {
      adjustedAmount,
      gasEstimateCost: gasEstimate.gasCost,
      feeCalculatorReserved: reservedAmount || 'not-available',
      usingReservedAmount: actualReservedAmount.toString(),
      balance,
      note: reservedAmount
        ? 'Using fee calculator reserved amount (more accurate)'
        : 'Using gas estimate cost (fallback)',
    });

    while (refinementIteration < MAX_REFINEMENT_ITERATIONS) {
      const updatedQuote = route.providerRef as any;
      const quoteSellAmount =
        updatedQuote?.sellAmount || updatedQuote?.value || '0';
      const quoteSellAmountBigInt = BigInt(quoteSellAmount);

      // Check if quote's sellAmount fits within available balance (accounting for actual reserved fees)
      const totalRequired = quoteSellAmountBigInt + actualReservedAmount;

      if (totalRequired <= balanceBigInt) {
        this.logger.log(
          '✅ Quote amount + reserved fees fit within available balance, no further refinement needed',
          {
            quoteSellAmount: quoteSellAmount.toString(),
            reservedAmount: actualReservedAmount.toString(),
            totalRequired: totalRequired.toString(),
            balance: balance,
            iteration: refinementIteration,
            note: 'Using actual reserved amount from fee calculator for accurate validation',
          },
        );
        // Update lastRequestedAmount with the successful quote's sellAmount
        lastRequestedAmount = quoteSellAmount;
        break; // Quote is acceptable
      }

      // Quote amount + reserved fees exceed balance - need to refine
      refinementIteration++;

      if (refinementIteration >= MAX_REFINEMENT_ITERATIONS) {
        this.logger.error(
          '❌ Max refinement iterations reached, quote still exceeds balance',
          {
            quoteSellAmount: quoteSellAmount.toString(),
            reservedAmount: actualReservedAmount.toString(),
            totalRequired: totalRequired.toString(),
            balance: balance,
            iterations: refinementIteration,
            note: 'Aggregator consistently returns amounts + fees larger than available balance',
          },
        );
        throw new Error(
          `Cannot find feasible quote: Aggregator requires ${quoteSellAmount} + fees ${actualReservedAmount.toString()} ` +
            `(total ${totalRequired.toString()}) but only ${balance} available after ${MAX_REFINEMENT_ITERATIONS} refinement attempts`,
        );
      }

      // Calculate how much we need to reduce the REQUESTED amount
      // The aggregator returned more than we asked for, so we need to ask for less next time
      const excessAmount = totalRequired - balanceBigInt;

      // Reduce requested amount by: excess + 5% safety margin
      const safetyMargin = (excessAmount * BigInt(5)) / BigInt(100);
      const newRequestedAmount =
        balanceBigInt -
        actualReservedAmount -
        rubicRoundingBuffer -
        excessAmount -
        safetyMargin;

      if (newRequestedAmount <= 0n) {
        throw new Error(
          `Cannot refine amount further: Would result in zero or negative requested amount. ` +
            `Balance: ${balance}, TotalRequired: ${totalRequired.toString()}, Excess: ${excessAmount.toString()}`,
        );
      }

      const newRequestedAmountStr = newRequestedAmount.toString();
      currentRequestedAmount = newRequestedAmountStr;

      this.logger.warn(
        '⚠️ Aggregator returned quote + fees that exceed balance, refining...',
        {
          iteration: refinementIteration,
          quoteSellAmount: quoteSellAmount.toString(),
          reservedAmount: actualReservedAmount.toString(),
          totalRequired: totalRequired.toString(),
          balance: balance,
          excessAmount: excessAmount.toString(),
          safetyMargin: safetyMargin.toString(),
          newRequestedAmount: newRequestedAmountStr,
          calculation: `newRequestedAmount = balance - reservedAmount - rubicBuffer - excess - safetyMargin`,
        },
      );

      // Fetch new quote with reduced REQUESTED amount
      // This will regenerate transaction.data for the new amount
      await this.adjustSwapAmount(
        context,
        newRequestedAmountStr,
        gasEstimate.gasCost,
      );

      // Update lastRequestedAmount for next iteration
      lastRequestedAmount = newRequestedAmountStr;

      // Update adjustment metadata with refined amount
      if (context.request.amountAdjustment) {
        // Note: We update adjustedAmount with the REQUESTED amount, not the quote's sellAmount
        // After the loop, we'll finalize with the actual quote's sellAmount if it fits
        context.request.amountAdjustment.adjustedAmount = newRequestedAmountStr;
        context.request.amountAdjustment.adjustedOutputAmount =
          route.totalEstimatedOut || '0';
      }
    }

    // CRITICAL: User insight - "even if we calculate the gas cost one time it would be fine because
    // we are only recalculating the swap amount which will not affect too much on the future gas cost"
    //
    // Problem: Re-estimating gas after fetching new quote causes:
    // 1. Unnecessary network calls (gas estimation is expensive)
    // 2. Gas estimate variations (e.g., 178949 vs 178961) due to network conditions
    // 3. These small variations trigger refinement logic unnecessarily
    // 4. Multiple refinements cause infinite loops
    //
    // Solution: Use the gas cost from the initial estimate. The swap amount change is minimal
    // (typically < 0.1% of balance) and does not significantly affect gas cost. The 100 wei buffer
    // provides sufficient safety margin for Rubic API rounding differences.
    //
    // NO REFINEMENT: Once we calculate gas cost, we use it. Re-estimating gas after adjusting
    // the swap amount causes unnecessary variations without meaningful benefit.
    const finalGasEstimate = gasEstimate;

    this.logger.debug(
      'Using initial gas estimate (no refinement needed per user insight)',
      {
        gasCost: gasEstimate.gasCost,
        gasLimit: gasEstimate.gasLimit,
        note: 'Gas cost calculated once - swap amount change does not significantly affect gas cost. 100 wei buffer provides safety margin.',
      },
    );

    // Store adjustment details in context
    const newOutputAmount = context.request.route.totalEstimatedOut || '0';
    // Get updated quote after adjustSwapAmount() - it may have been updated with new quote data
    const updatedSwapQuote = context.request.route.providerRef as any;

    // CRITICAL: After refinement loop completes successfully, use the quote's sellAmount as final amount
    // The refinement loop ensures the quote's sellAmount + gas fits within balance
    // The quote's sellAmount is what the transaction.data is built for, so we MUST use it
    const finalAdjustedAmount =
      updatedSwapQuote?.sellAmount ||
      updatedSwapQuote?.value ||
      lastRequestedAmount;

    // CRITICAL: Preserve originalAmount from existing amountAdjustment if it exists (during refinement)
    // This ensures originalAmount always refers to the user's original request, not an intermediate adjusted amount
    const preservedOriginalAmount =
      context.request.amountAdjustment?.originalAmount || originalAmount;

    // Validate the final amount fits within balance (sanity check)
    const finalAmountBigInt = BigInt(finalAdjustedAmount);
    const totalRequired = finalAmountBigInt + actualReservedAmount;

    if (totalRequired > balanceBigInt) {
      this.logger.error(
        'Final adjusted amount + reserved fees still exceed balance - this should not happen',
        {
          finalAdjustedAmount,
          reservedAmount: actualReservedAmount.toString(),
          totalRequired: totalRequired.toString(),
          balance,
          note: 'Refinement loop completed but result still exceeds balance',
        },
      );
      throw new Error(
        `Final amount validation failed: ${finalAdjustedAmount} + fees ${actualReservedAmount.toString()} ` +
          `(total ${totalRequired.toString()}) exceeds balance ${balance}`,
      );
    }

    this.logger.log('Final adjusted amount validated', {
      finalAdjustedAmount,
      reservedAmount: actualReservedAmount.toString(),
      totalRequired: totalRequired.toString(),
      balance,
      remainingBalance: (balanceBigInt - totalRequired).toString(),
      note: 'Using actual reserved amount from fee calculator',
    });

    const adjustment: AmountAdjustment = {
      originalAmount: preservedOriginalAmount, // Always use the original request amount, not intermediate adjusted amounts
      adjustedAmount: finalAdjustedAmount, // Use quote's sellAmount as source of truth
      reserved: reservedAmount, // Store actual reserved amount from fee calculator
      feeBreakdown, // Include fee breakdown if available from calculator
      gasCost: finalGasEstimate.gasCost,
      gasLimit: finalGasEstimate.gasLimit, // Store accurate gas limit for use in buildTransaction
      reason: swapFullBalance
        ? 'User requested full balance swap (0.1% reserved in wallet)'
        : 'Balance insufficient for requested amount + gas fees',
      originalOutputAmount,
      adjustedOutputAmount: newOutputAmount,
    };

    context.request.amountAdjustment = adjustment;

    // Calculate and log remaining balance after adjustment (before transaction)
    const finalAdjustedAmountBigInt = BigInt(finalAdjustedAmount);
    const expectedRemainingBalance =
      balanceBigInt - finalAdjustedAmountBigInt - actualReservedAmount;

    this.logger.log('Amount adjustment completed', {
      adjustment,
      remainingBalanceAnalysis: {
        initialBalance: balance,
        adjustedAmount: finalAdjustedAmount,
        actualReservedAmount: actualReservedAmount.toString(),
        expectedRemainingBalance: expectedRemainingBalance.toString(),
        expectedRemainingBalancePercent:
          balanceBigInt > 0n
            ? (
                (expectedRemainingBalance * BigInt(10000)) /
                balanceBigInt
              ).toString() + ' basis points'
            : '0',
        note: 'Expected remaining = balance - adjustedAmount - actualReservedAmount. Using fee calculator reserved amount for accuracy.',
      },
    });
  }

  /**
   * Build transaction data specific to the executor
   *
   * NOTE: This method receives the same context object that was passed to preExecute().
   * Any modifications made in preExecute() (e.g., route updates, amount adjustments)
   * are automatically available here because JavaScript objects are passed by reference.
   *
   * Key context properties available:
   * - context.request.route.providerRef - Updated quote with adjusted amount (if adjustment occurred)
   * - context.request.amountAdjustment - Adjustment details (if adjustment occurred)
   * - context.request.routeId - Updated route ID (if new route was fetched)
   *
   * @param context - Execution context (may have been modified by preExecute())
   * @returns Transaction data ready to be sent to blockchain
   */
  protected abstract buildTransaction(context: ExecutionContext): Promise<{
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
  }>;

  /**
   * Send transaction to blockchain
   */
  protected abstract sendTransaction(
    txData: {
      to: string;
      data: string;
      value: string;
      gasLimit?: string;
      gasPrice?: string;
    },
    context: ExecutionContext,
  ): Promise<string>;

  /**
   * Wait for transaction confirmation
   */
  abstract waitForConfirmation(
    transactionHash: string,
    chainId: number | string,
    requiredConfirmations?: number,
  ): Promise<any>;

  /**
   * Post-execution cleanup or additional processing
   */
  protected async postExecute(
    context: ExecutionContext,
    txHash: string,
    receipt: any,
  ): Promise<void> {
    // Default implementation: no-op
    // Subclasses can override for specific cleanup
  }

  /**
   * Get required confirmations for this executor
   * Can be overridden by subclasses to provide chain-specific confirmations
   * @param chainId - Optional chain ID for chain-specific confirmation requirements
   */
  protected getRequiredConfirmations(chainId?: number | string): number {
    return 1; // Default: 1 confirmation
  }

  /**
   * Get blockchain explorer URL for a transaction
   * Can be overridden by subclasses to provide chain-specific URLs
   * Default implementation returns undefined
   */
  protected getExplorerUrl(
    chainId: number | string,
    txHash: string,
  ): string | undefined {
    // Default: no explorer URL
    // Subclasses (EVM, Solana, etc.) should override this
    return undefined;
  }

  private performFallbackAdjustment(
    ecosystem: string,
    balance: string,
    gasEstimate: { gasLimit: string; gasCost: string },
    originalAmount: string,
  ): { adjustedAmount: string; reservedAmount: string } {
    const balanceBigInt = BigInt(balance);
    const gasCostBigInt = BigInt(gasEstimate.gasCost);
    const rubicRoundingBuffer = BigInt(100);

    if (ecosystem === 'evm') {
      const adjusted = balanceBigInt - gasCostBigInt - rubicRoundingBuffer;

      if (adjusted <= 0n) {
        this.logger.warn('EVM balance too low', { balance });
        throw new Error('Insufficient balance for EVM transaction fees');
      }

      const adjustedAmount = adjusted.toString();
      const reservedAmount = (gasCostBigInt + rubicRoundingBuffer).toString();

      this.logger.log('EVM fallback adjustment', {
        adjustedAmount,
        reserved: reservedAmount,
      });

      return { adjustedAmount, reservedAmount };
    } else if (ecosystem === 'solana') {
      const adjusted = balanceBigInt - rubicRoundingBuffer;

      if (adjusted <= 0n) {
        this.logger.warn('Solana balance too low', { balance });
        throw new Error('Insufficient balance for Solana transaction');
      }

      const adjustedAmount = adjusted.toString();
      const reservedAmount = rubicRoundingBuffer.toString();

      this.logger.log('Solana fallback adjustment', {
        adjustedAmount,
        reserved: reservedAmount,
      });

      return { adjustedAmount, reservedAmount };
    } else {
      const buffer = BigInt(100);
      const adjusted = balanceBigInt - gasCostBigInt - buffer;

      if (adjusted <= 0n) {
        this.logger.warn(`${ecosystem} balance too low`, { balance });
        throw new Error(
          `Insufficient balance for ${ecosystem} transaction fees`,
        );
      }

      const adjustedAmount = adjusted.toString();
      const reservedAmount = (gasCostBigInt + buffer).toString();

      this.logger.log(`${ecosystem} fallback adjustment`, {
        adjustedAmount,
        reserved: reservedAmount,
      });

      return { adjustedAmount, reservedAmount };
    }
  }

  /**
   * Get provider-specific tracking URL for cross-chain swaps
   * Returns bridge/aggregator explorer URL for monitoring cross-chain transfers
   * Examples: LiFi scan, Socket scan, Rubic status API, etc.
   *
   * @param route - The route being executed
   * @param txHash - Transaction hash on source chain
   * @returns Provider tracking URL or undefined if not applicable
   */
  protected getProviderTrackingUrl(
    route: RouteQuote,
    txHash: string,
  ): string | undefined {
    // Only applicable for cross-chain swaps
    if (!this.isCrossChainSwap(route)) {
      return undefined;
    }

    const providerRef = route.providerRef as any;
    const aggregator = providerRef?.aggregator?.toLowerCase();
    const providerType = providerRef?.providerType?.toLowerCase();

    // Map of provider-specific explorers for cross-chain tracking
    const providerExplorers: Record<string, (txHash: string) => string> = {
      // LiFi - Best cross-chain explorer
      lifi: (hash) => `https://scan.li.fi/tx/${hash}`,

      // Socket (formerly Bungee)
      socket: (hash) => `https://socketscan.io/tx/${hash}`,

      // Rubic
      rubic: (hash) =>
        `https://api-v2.rubic.exchange/api/info/status?srcTxHash=${hash}`,

      // Stargate
      stargate: (hash) => `https://stargate.finance/tx/${hash}`,

      // Across
      across: (hash) => `https://across.to/transactions?search=${hash}`,

      // Symbiosis
      symbiosis: (hash) => `https://app.symbiosis.finance/explorer/tx/${hash}`,

      // Hop Protocol
      hop: (hash) => `https://explorer.hop.exchange/tx/${hash}`,

      // Connext
      connext: (hash) => `https://connextscan.io/tx/${hash}`,

      // Squid Router
      squid: (hash) => `https://axelarscan.io/gmp/${hash}`,
      squidrouter: (hash) => `https://axelarscan.io/gmp/${hash}`,

      // Rango
      rango: (hash) => `https://rango.exchange/tx/${hash}`,

      // Relay
      relay: (hash) => `https://relay.link/tx/${hash}`,
    };

    // Try to get provider-specific explorer URL
    const providerExplorerFn =
      providerExplorers[aggregator] || providerExplorers[providerType];

    if (providerExplorerFn) {
      this.logger.debug(
        `Using provider-specific tracking URL for ${aggregator || providerType}`,
      );
      return providerExplorerFn(txHash);
    }

    // No provider-specific tracking URL available
    return undefined;
  }

  /**
   * Check if a route is a cross-chain swap
   * @param route - The route to check
   * @returns true if cross-chain, false if on-chain
   */
  protected isCrossChainSwap(route: RouteQuote): boolean {
    if (!route.steps || route.steps.length === 0) {
      return false;
    }

    // Check if there are multiple distinct chain IDs in the steps
    const chainIds = new Set(route.steps.map((step) => step.chainId));
    return chainIds.size > 1;
  }

  /**
   * Helper method to handle retries with exponential backoff
   */
  protected async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.logger.warn(
            `Attempt ${attempt + 1} failed, retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  /**
   * Parse receipt status from different chain formats
   * Different chains return status in different formats:
   * - EVM chains: 1 (success) or 0 (failure) as number
   * - Some RPCs: '0x1' or '0x0' as hex string
   * - Some SDKs: 'success' or 'failed' as string
   * - Some chains: true or false as boolean
   */
  protected parseReceiptStatus(status: any): 'SUCCESS' | 'FAILED' | 'PENDING' {
    // Handle success cases
    if (
      status === 1 ||
      status === '0x1' ||
      status === 'success' ||
      status === true
    ) {
      return 'SUCCESS';
    }

    // Handle failure cases
    if (
      status === 0 ||
      status === '0x0' ||
      status === 'failed' ||
      status === 'reverted' ||
      status === false
    ) {
      return 'FAILED';
    }

    // Handle pending/unknown cases
    if (status === 'pending' || status === null || status === undefined) {
      this.logger.warn(`Transaction status is pending or unknown: ${status}`);
      return 'PENDING';
    }

    // Unexpected status format - log warning and default to FAILED for safety
    this.logger.warn(
      `Unexpected receipt status format: ${status} (type: ${typeof status})`,
    );
    return 'FAILED';
  }
}
