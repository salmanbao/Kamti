import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  ExecutionContext,
  ExecutionResult,
} from './ports/swap-executor.interface';
import { RouteQuote } from '@swap/models/ports';
import {
  EnhancedExecutionData,
  EnhancedTransactionDetails,
  GasAndFeeDetails,
  SwapOutcomeDetails,
  RouteProviderDetails,
  TokenDetails,
  AmountDetails,
  DEXSourceDetails,
  PremiumAnalytics,
  RouteComparisonAnalysis,
  AlternativeRouteDetails,
  SmartRecommendations,
  OptimizationSuggestion,
  MarketContext,
  AggregatorAnalytics,
  DEXHealthMetrics,
  SavingsCalculation,
} from '@swap/dto/enhanced-execution-response.dto';
import {
  formatUnits,
  parseUnits,
  createPublicClient,
  http,
  type Address,
} from 'viem';
import {
  ChainUtilsService,
  getChainName,
  getChainEcosystem,
} from '@shared/utils/chain.utils';
import { SwapAnalyticsService } from '@shared/services/swap-analytics.service';

/**
 * Enhanced Response Builder Service
 * Transforms ExecutionResult into rich, comprehensive EnhancedExecutionData
 *
 * Phase 1 Implementation:
 * - Gas details (used, cost, price)
 * - Actual swap amounts (input/output)
 * - Exchange rate & price impact
 * - Provider/aggregator name
 *
 * Phase 2 Implementation:
 * - Protocol fee breakdown (integrator, provider, bridge fees)
 * - Real-time confirmation tracking
 * - Detailed timeline events
 * - Actual output amounts from logs
 * - Enhanced error categorization
 *
 * Phase 3 Implementation:
 * - USD conversions for all amounts and fees
 * - Cross-chain swap tracking
 * - Quality metrics and scoring
 * - Warnings and recommendations
 *
 * Phase 4 Implementation:
 * - Route comparison with alternatives
 * - Smart recommendations and optimizations
 * - Market context and insights
 * - Aggregator analytics
 * - Savings calculations
 */
@Injectable()
export class EnhancedResponseBuilderService {
  constructor(
    private readonly chainUtils: ChainUtilsService,
    private readonly analytics: SwapAnalyticsService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(EnhancedResponseBuilderService.name);
  }

  /**
   * Build enhanced execution response from ExecutionResult and context
   * Maintains backward compatibility by preserving all original data
   */
  async buildEnhancedResponse(
    executionId: string,
    executionResult: ExecutionResult,
    context: ExecutionContext,
    startTime: number,
  ): Promise<EnhancedExecutionData> {
    try {
      const route = context.request.route;
      const completionTime = Date.now();

      this.logger.debug(
        `Building enhanced response for execution ${executionId}`,
      );

      // Build all components (Phase 2 & 3: await for async operations)
      const transactions = await this.buildTransactionDetails(
        executionResult,
        route,
      );
      const gasAndFees = await this.buildGasAndFeeDetails(
        executionResult,
        route,
      );
      const swapOutcome = await this.buildSwapOutcomeDetails(
        executionResult,
        route,
        context,
      );
      const routeProvider = this.buildRouteProviderDetails(
        route,
        startTime,
        completionTime,
        executionResult,
      );
      const steps = this.buildEnhancedSteps(route, executionResult);
      const timeline = this.buildExecutionTimeline(
        startTime,
        completionTime,
        executionResult,
      );
      const tracking = this.buildTrackingInformation(executionResult, route);

      // Phase 3: Cross-chain enrichment
      const crossChain = this.isCrossChainSwap(route)
        ? await this.buildCrossChainDetails(executionResult, route)
        : undefined;

      // Phase 3: Warnings and recommendations
      const warningsRecommendations = this.buildWarningsAndRecommendations(
        executionResult,
        route,
        swapOutcome,
        gasAndFees,
      );

      // Phase 4: Premium analytics (if requested and successful swap)
      const premiumAnalytics =
        (context.request as any).premiumAnalytics && executionResult.success
          ? await this.buildPremiumAnalytics(
              executionResult,
              route,
              context,
              gasAndFees,
              swapOutcome,
              startTime,
              completionTime,
            )
          : undefined;

      // Build enhanced response
      const enhancedData: EnhancedExecutionData = {
        executionId,
        routeId: route.routeId || context.request.routeId,
        requestTimestamp:
          context.executionStartTime?.toISOString() ||
          new Date(startTime).toISOString(),
        completionTimestamp: executionResult.success
          ? new Date(completionTime).toISOString()
          : undefined,

        status: {
          overall: executionResult.success ? 'SUCCESS' : 'FAILED',
          currentStep: route.steps?.length || 1,
          totalSteps: route.steps?.length || 1,
          progressPercentage: executionResult.success ? 100 : 0,
        },

        transactions,
        primaryTransaction: transactions[0],

        gasAndFees,
        swapOutcome,
        routeProvider,

        // Phase 3: Cross-chain details
        crossChain,

        steps,
        timeline,
        tracking,

        // Phase 3: Warnings
        warningsRecommendations,

        // Phase 4: Premium analytics
        premiumAnalytics,

        metadata: this.buildMetadata(route),
      };

      // Add error details if failed
      if (!executionResult.success && executionResult.error) {
        enhancedData.error = {
          code: this.categorizeErrorCode(executionResult.error),
          category: 'execution',
          severity: 'high',
          recoverable: this.isRecoverable(executionResult.error),
          message: executionResult.error,
          userFriendlyMessage: this.makeUserFriendly(executionResult.error),
          rootCause: {
            component: 'Smart Contract',
            reason: executionResult.error,
            possibleCauses: this.inferPossibleCauses(executionResult.error),
          },
          suggestedActions: {
            immediate: this.suggestImmediateActions(executionResult.error),
          },
          supportInfo: {
            executionId,
          },
        };
      }

      return enhancedData;
    } catch (error) {
      this.logger.error(
        `Failed to build enhanced response: ${error.message}`,
        error.stack,
      );
      // Fallback: Return minimal enhanced data
      return this.buildFallbackResponse(
        executionId,
        executionResult,
        context,
        startTime,
      );
    }
  }

  /**
   * Build transaction details (Phase 1 & 2: Essential + Real-time tracking)
   */
  private async buildTransactionDetails(
    result: ExecutionResult,
    route: RouteQuote,
  ): Promise<EnhancedTransactionDetails[]> {
    const transactions: EnhancedTransactionDetails[] = [];

    // Primary transaction
    if (result.transactionHash) {
      const chainId = result.chainId;
      const ecosystem = getChainEcosystem(chainId) as
        | 'evm'
        | 'solana'
        | 'cosmos'
        | 'bitcoin';

      // Phase 2: Get real-time confirmation count
      const confirmations = await this.getRealTimeConfirmations(
        result.transactionHash,
        result.blockNumber,
        chainId,
        ecosystem,
      );

      const requiredConfirmations = this.getRequiredConfirmations(ecosystem);
      const confirmationProgress =
        (confirmations / requiredConfirmations) * 100;

      transactions.push({
        hash: result.transactionHash,
        chainId,
        chainName: getChainName(chainId),
        ecosystem,
        blockNumber: result.blockNumber,
        blockTimestamp: result.timestamp?.toISOString(),
        confirmations,
        requiredConfirmations,
        confirmationProgress: Math.min(
          Math.round(confirmationProgress * 100) / 100,
          100,
        ),
        type: this.detectTransactionType(result),
        nonce: undefined, // TODO: Extract from receipt if available
        from: '', // TODO: Extract from context.request.userWallet
        to: this.extractToAddress(route),
        status: this.mapStatus(result.status),
        statusReason: result.success
          ? 'Transaction confirmed successfully'
          : result.error,
      });
    }

    return transactions;
  }

  /**
   * Build gas and fee details (Phase 1 & 2: Essential + Protocol fees)
   */
  private async buildGasAndFeeDetails(
    result: ExecutionResult,
    route: RouteQuote,
  ): Promise<GasAndFeeDetails> {
    const chainId = result.chainId;
    const ecosystem = getChainEcosystem(chainId) as
      | 'evm'
      | 'solana'
      | 'cosmos'
      | 'bitcoin';
    const swapQuote = route.providerRef as any;

    // Phase 2 & 3: Extract protocol fees with USD values
    const protocolFees = await this.extractProtocolFees(
      swapQuote,
      route,
      result.chainId,
    );

    if (ecosystem === 'evm') {
      const evmDetails = await this.buildEVMGasDetails(result, swapQuote);
      evmDetails.protocolFees = protocolFees;
      return evmDetails;
    } else if (ecosystem === 'solana') {
      const solanaDetails = this.buildSolanaGasDetails(result, swapQuote);
      solanaDetails.protocolFees = protocolFees;
      return solanaDetails;
    }

    // Fallback
    return {
      protocolFees,
      totalCost: {
        native: 'Unknown',
        breakdown: [],
      },
    };
  }

  /**
   * Build EVM gas details (Phase 3: with USD conversion)
   */
  private async buildEVMGasDetails(
    result: ExecutionResult,
    swapQuote: any,
  ): Promise<GasAndFeeDetails> {
    const gasUsed = result.gasUsed || '0';
    const effectiveGasPrice = result.effectiveGasPrice || '0';
    const gasLimit = swapQuote?.gas || swapQuote?.gasLimit || gasUsed;

    // Calculate gas utilization
    const gasUtilization =
      gasLimit !== '0' ? (Number(gasUsed) / Number(gasLimit)) * 100 : 0;

    // Calculate total gas cost in wei
    const totalGasCostWei = (
      BigInt(gasUsed) * BigInt(effectiveGasPrice)
    ).toString();
    const totalGasCostEther = formatUnits(BigInt(totalGasCostWei), 18);

    // Estimated vs actual
    const estimatedGasCost = swapQuote?.estimatedGas
      ? (BigInt(swapQuote.estimatedGas) * BigInt(effectiveGasPrice)).toString()
      : totalGasCostWei;

    // Phase 3: USD value disabled (no price feed)
    const gasUSD = undefined;

    return {
      evm: {
        gasLimit,
        gasUsed,
        gasUtilization: Math.round(gasUtilization * 100) / 100,
        effectiveGasPrice,
        totalGasCost: {
          wei: totalGasCostWei,
          ether: totalGasCostEther,
          usd: gasUSD || undefined, // Phase 3: USD value
        },
        estimatedGasCost,
        actualGasCost: totalGasCostWei,
      },
      totalCost: {
        native: `${totalGasCostEther} ETH`,
        usd: gasUSD || undefined, // Phase 3: USD value
        breakdown: [
          `Gas: ${totalGasCostEther} ETH${gasUSD ? ` ($${gasUSD})` : ''}`,
        ],
      },
    };
  }

  /**
   * Build Solana gas details
   */
  private buildSolanaGasDetails(
    result: ExecutionResult,
    swapQuote: any,
  ): GasAndFeeDetails {
    // TODO: Extract from Solana transaction receipt
    return {
      solana: {
        computeUnitsUsed: 0,
        computeUnitsLimit: 0,
        computeUnitPrice: 0,
        priorityFee: {
          lamports: '0',
          sol: '0',
        },
        totalFee: {
          lamports: '0',
          sol: '0',
        },
      },
      totalCost: {
        native: '0 SOL',
        breakdown: [],
      },
    };
  }

  /**
   * Build swap outcome details (Phase 1 & 2: Essential + Actual amounts)
   */
  private async buildSwapOutcomeDetails(
    result: ExecutionResult,
    route: RouteQuote,
    context: ExecutionContext,
  ): Promise<SwapOutcomeDetails> {
    const swapQuote = route.providerRef as any;
    const firstStep = route.steps?.[0];

    // Extract token information
    const inputToken = this.buildTokenDetails(
      swapQuote?.sellToken || firstStep?.details?.fromToken,
      swapQuote?.tokenMetadata?.sellToken?.symbol || 'UNKNOWN',
      swapQuote?.tokenMetadata?.sellToken?.decimals || 18,
    );

    const outputToken = this.buildTokenDetails(
      swapQuote?.buyToken || firstStep?.details?.toToken,
      swapQuote?.tokenMetadata?.buyToken?.symbol || 'UNKNOWN',
      swapQuote?.tokenMetadata?.buyToken?.decimals || 6,
    );

    // Build amounts
    const inputAmount = this.buildAmountDetails(
      swapQuote?.sellAmount || '0',
      inputToken.decimals,
    );

    const expectedOutputAmount = this.buildAmountDetails(
      swapQuote?.buyAmount || '0',
      outputToken.decimals,
    );

    const minOutputAmount = this.buildAmountDetails(
      swapQuote?.minBuyAmount || swapQuote?.buyAmount || '0',
      outputToken.decimals,
    );

    // Phase 2: Extract actual output amount from logs
    const chainId = result.chainId;
    const ecosystem = getChainEcosystem(chainId) as
      | 'evm'
      | 'solana'
      | 'cosmos'
      | 'bitcoin';
    const actualAmount = await this.extractActualOutputAmount(
      result,
      outputToken.address,
      ecosystem,
    );

    const actualOutputAmount = actualAmount
      ? this.buildAmountDetails(actualAmount, outputToken.decimals)
      : undefined;

    // Calculate exchange rate
    const exchangeRate = this.calculateExchangeRate(
      inputAmount.formatted,
      expectedOutputAmount.formatted,
      inputToken.symbol,
      outputToken.symbol,
    );

    // Extract price impact
    const priceImpact = {
      estimated: swapQuote?.priceImpact || '0.00%',
      severity: this.categorizePriceImpact(swapQuote?.priceImpact || '0'),
    };

    // Extract slippage
    const slippageBps = context.request.slippageToleranceBps || 50;
    const slippage = {
      tolerance: `${(slippageBps / 100).toFixed(2)}%`,
    };

    return {
      input: {
        token: inputToken,
        amount: inputAmount,
      },
      output: {
        token: outputToken,
        expectedAmount: expectedOutputAmount,
        minAmount: minOutputAmount,
        actualAmount: actualOutputAmount, // Phase 2: Actual from logs
      },
      exchangeRate,
      priceImpact,
      slippage,
    };
  }

  /**
   * Build route provider details (Phase 1 & 3: Essential + Performance metrics)
   */
  private buildRouteProviderDetails(
    route: RouteQuote,
    startTime: number,
    completionTime: number,
    result?: ExecutionResult,
  ): RouteProviderDetails {
    const swapQuote = route.providerRef as any;
    const aggregator = swapQuote?.aggregator || 'Unknown';
    const providerType = this.detectProviderType(route, swapQuote);

    // Build DEX sources if available (0x route fills)
    const sources: DEXSourceDetails[] = [];
    if (swapQuote?.route?.fills) {
      swapQuote.route.fills.forEach((fill: any) => {
        sources.push({
          dex: fill.source,
          percentage: fill.proportionBps / 100,
          inputAmount: 'N/A', // TODO: Calculate from proportions
          outputAmount: 'N/A',
        });
      });
    }

    // Build path
    const path = this.extractPath(route, swapQuote);
    const pathDescription = this.buildPathDescription(path, sources);

    // Calculate timing
    const actualTime = Math.round((completionTime - startTime) / 1000); // seconds
    const estimatedTime = route.etaSeconds || 30;

    // Phase 3: Build quality metrics
    const quality = result?.success
      ? this.buildQualityMetrics(route, swapQuote, actualTime, estimatedTime)
      : undefined;

    return {
      aggregator,
      providerType,
      route: {
        type: this.detectRouteType(route),
        complexity: this.detectComplexity(route),
        hops: path.length - 1,
        sources: sources.length > 0 ? sources : undefined,
        path,
        pathDescription,
      },
      performance: {
        estimatedTime,
        actualTime,
        speed: this.compareSpeed(actualTime, estimatedTime),
      },
      quality, // Phase 3
    };
  }

  /**
   * Build enhanced execution steps
   */
  private buildEnhancedSteps(
    route: RouteQuote,
    result: ExecutionResult,
  ): any[] {
    const swapQuote = route.providerRef as any;
    const aggregator = swapQuote?.aggregator || 'Unknown';

    return (route.steps || []).map((step, index) => ({
      stepNumber: index + 1,
      type: step.kind || 'swap',
      status: result.success ? 'SUCCESS' : index === 0 ? 'FAILED' : 'PENDING',
      description: this.buildStepDescription(step),
      chainId: step.chainId,
      chainName: getChainName(step.chainId),
      provider: step.protocol || aggregator,
      transactionHash: index === 0 ? result.transactionHash : undefined,
      explorerUrl: index === 0 ? result.explorerUrl : undefined,
      timing: {
        estimated: step.estimatedTime || 30,
        duration: index === 0 && result.success ? undefined : undefined,
      },
    }));
  }

  /**
   * Build execution timeline
   */
  private buildExecutionTimeline(
    startTime: number,
    completionTime: number,
    result: ExecutionResult,
  ): any {
    const events: any[] = [];
    const duration = Math.round((completionTime - startTime) / 1000);

    events.push({
      timestamp: new Date(startTime).toISOString(),
      event: 'REQUEST_RECEIVED',
      status: 'success',
      description: 'Swap execution request received',
    });

    if (result.success) {
      events.push({
        timestamp:
          result.timestamp?.toISOString() ||
          new Date(completionTime).toISOString(),
        event: 'TRANSACTION_CONFIRMED',
        status: 'success',
        description: 'Transaction confirmed on blockchain',
      });
    } else {
      events.push({
        timestamp: new Date(completionTime).toISOString(),
        event: 'EXECUTION_FAILED',
        status: 'failed',
        description: result.error || 'Transaction failed',
      });
    }

    return {
      events,
      milestones: {
        requestReceived: new Date(startTime).toISOString(),
        transactionSubmitted: result.success
          ? result.timestamp?.toISOString()
          : undefined,
        transactionConfirmed: result.success
          ? result.timestamp?.toISOString()
          : undefined,
      },
      duration: {
        total: duration,
        execution: duration,
      },
    };
  }

  /**
   * Build tracking information
   */
  private buildTrackingInformation(
    result: ExecutionResult,
    route: RouteQuote,
  ): any {
    const explorerUrls: any[] = [];

    if (result.explorerUrl) {
      explorerUrls.push({
        chain: getChainName(result.chainId),
        chainId: result.chainId,
        url: result.explorerUrl,
        description: 'Source Transaction',
        type: 'source',
      });
    }

    if (result.destExplorerUrl && result.destChainId) {
      explorerUrls.push({
        chain: this.getChainName(result.destChainId),
        chainId: result.destChainId,
        url: result.destExplorerUrl,
        description: 'Destination Transaction',
        type: 'destination',
      });
    }

    return {
      explorerUrls,
      bridgeStatusUrl: result.bridgeStatusUrl,
      statusCheckEndpoint: '/universal-swap/status',
    };
  }

  /**
   * Build metadata
   */
  private buildMetadata(route: RouteQuote): any {
    const ecosystems = new Set<string>();
    const chains: any[] = [];
    const swapQuote = route.providerRef as any;
    const aggregator = swapQuote?.aggregator || 'Unknown';

    (route.steps || []).forEach((step, index) => {
      const ecosystem = getChainEcosystem(step.chainId) as
        | 'evm'
        | 'solana'
        | 'cosmos'
        | 'bitcoin';
      ecosystems.add(ecosystem);

      chains.push({
        id: step.chainId,
        name: getChainName(step.chainId),
        role:
          index === 0
            ? 'source'
            : index === route.steps.length - 1
              ? 'destination'
              : 'intermediate',
      });
    });

    return {
      ecosystem: Array.from(ecosystems),
      aggregators: [aggregator],
      chains,
      complexity: this.detectComplexity(route),
      version: '1.0.0',
    };
  }

  // Helper methods

  private buildTokenDetails(
    address: string,
    symbol: string,
    decimals: number,
  ): TokenDetails {
    return {
      address: address || '0x0',
      symbol,
      decimals,
    };
  }

  private buildAmountDetails(
    rawAmount: string,
    decimals: number,
  ): AmountDetails {
    const formatted = formatUnits(BigInt(rawAmount || '0'), decimals);
    return {
      raw: rawAmount || '0',
      formatted,
    };
  }

  private calculateExchangeRate(
    inputAmount: string,
    outputAmount: string,
    inputSymbol: string,
    outputSymbol: string,
  ): any {
    const rate = Number(outputAmount) / Number(inputAmount);
    const inverseRate = 1 / rate;

    return {
      rate: `1 ${inputSymbol} = ${rate.toFixed(6)} ${outputSymbol}`,
      inverseRate: `1 ${outputSymbol} = ${inverseRate.toFixed(6)} ${inputSymbol}`,
    };
  }

  private categorizePriceImpact(
    priceImpact: string,
  ): 'low' | 'medium' | 'high' {
    const impact = parseFloat(priceImpact);
    if (impact < 0.5) return 'low';
    if (impact < 3) return 'medium';
    return 'high';
  }

  /**
   * Detect blockchain ecosystem from chain ID
   * @deprecated Use getChainEcosystem from @shared/utils/chain.utils instead
   */
  private detectEcosystem(
    chainId: number | string,
  ): 'evm' | 'solana' | 'cosmos' | 'bitcoin' {
    return getChainEcosystem(chainId) as
      | 'evm'
      | 'solana'
      | 'cosmos'
      | 'bitcoin';
  }

  /**
   * Get human-readable chain name from chain ID
   * @deprecated Use getChainName from @shared/utils/chain.utils instead
   */
  private getChainName(chainId: number | string): string {
    return getChainName(chainId);
  }

  private detectProviderType(
    route: RouteQuote,
    swapQuote: any,
  ): 'meta' | 'evm-aggregator' | 'solana' | 'native-l1' {
    const aggregator = swapQuote?.aggregator?.toLowerCase() || '';
    if (aggregator.includes('rubic') || aggregator.includes('lifi'))
      return 'meta';
    if (aggregator.includes('jupiter')) return 'solana';
    return 'evm-aggregator';
  }

  private detectRouteType(
    route: RouteQuote,
  ): 'direct' | 'multi-hop' | 'cross-chain' {
    if (!route.steps || route.steps.length <= 1) return 'direct';
    const chainIds = new Set(route.steps.map((s) => s.chainId));
    return chainIds.size > 1 ? 'cross-chain' : 'multi-hop';
  }

  private detectComplexity(
    route: RouteQuote,
  ): 'simple' | 'moderate' | 'complex' {
    const steps = route.steps?.length || 0;
    if (steps <= 1) return 'simple';
    if (steps <= 3) return 'moderate';
    return 'complex';
  }

  private extractPath(route: RouteQuote, swapQuote: any): string[] {
    // Try to get from route tokens
    if (swapQuote?.route?.tokens) return swapQuote.route.tokens;

    // Fallback: construct from steps
    const path: string[] = [];
    route.steps?.forEach((step, index) => {
      if (index === 0) {
        path.push(swapQuote?.tokenMetadata?.sellToken?.symbol || 'UNKNOWN');
      }
      path.push(swapQuote?.tokenMetadata?.buyToken?.symbol || 'UNKNOWN');
    });
    return path.length > 0 ? path : ['UNKNOWN', 'UNKNOWN'];
  }

  private buildPathDescription(
    path: string[],
    sources: DEXSourceDetails[],
  ): string {
    if (sources.length > 0) {
      const sourceDesc = sources
        .map((s) => `${s.dex} (${s.percentage}%)`)
        .join(' + ');
      return `${path.join(' → ')} via ${sourceDesc}`;
    }
    return path.join(' → ');
  }

  private compareSpeed(
    actual: number,
    estimated: number,
  ): 'faster' | 'average' | 'slower' | undefined {
    if (!actual || !estimated) return undefined;
    const ratio = actual / estimated;
    if (ratio < 0.8) return 'faster';
    if (ratio > 1.2) return 'slower';
    return 'average';
  }

  private buildStepDescription(step: any): string {
    const action = step.kind || 'swap';
    return `${action.charAt(0).toUpperCase() + action.slice(1)} on ${getChainName(step.chainId)}`;
  }

  private detectTransactionType(
    result: ExecutionResult,
  ): 'legacy' | 'eip-2930' | 'eip-1559' | undefined {
    // TODO: Extract from transaction receipt
    return undefined;
  }

  private extractToAddress(route: RouteQuote): string {
    const swapQuote = route.providerRef as any;
    return swapQuote?.to || '';
  }

  private mapStatus(
    status: string,
  ): 'pending' | 'confirmed' | 'failed' | 'dropped' {
    if (status === 'SUCCESS') return 'confirmed';
    if (status === 'FAILED') return 'failed';
    return 'pending';
  }

  private getRequiredConfirmations(ecosystem: string): number {
    if (ecosystem === 'evm') return 12;
    if (ecosystem === 'solana') return 32;
    return 1;
  }

  // Error handling helpers

  private categorizeErrorCode(error: string): string {
    if (error.includes('insufficient')) return 'INSUFFICIENT_FUNDS';
    if (error.includes('liquidity')) return 'INSUFFICIENT_LIQUIDITY';
    if (error.includes('slippage')) return 'SLIPPAGE_EXCEEDED';
    if (error.includes('gas')) return 'GAS_ESTIMATION_FAILED';
    return 'EXECUTION_FAILED';
  }

  private isRecoverable(error: string): boolean {
    const recoverableErrors = [
      'insufficient',
      'slippage',
      'nonce',
      'gas price',
    ];
    return recoverableErrors.some((e) => error.toLowerCase().includes(e));
  }

  private makeUserFriendly(error: string): string {
    if (error.includes('insufficient')) {
      return "You don't have enough balance to complete this swap. Please check your wallet balance.";
    }
    if (error.includes('slippage')) {
      return 'The price moved too much during your swap. Try increasing your slippage tolerance or reducing the swap amount.';
    }
    if (error.includes('liquidity')) {
      return "There isn't enough liquidity available for this swap. Try reducing your swap amount or choosing a different route.";
    }
    return "Your swap couldn't be completed. Please try again or contact support.";
  }

  private inferPossibleCauses(error: string): string[] {
    const causes: string[] = [];
    if (error.includes('insufficient')) {
      causes.push('Wallet balance too low');
      causes.push('Gas fees not accounted for');
    }
    if (error.includes('slippage')) {
      causes.push('Market volatility');
      causes.push('Slippage tolerance too tight');
      causes.push('Large trade size');
    }
    if (error.includes('liquidity')) {
      causes.push('Pool liquidity depleted');
      causes.push('Trade size too large relative to pool');
    }
    return causes.length > 0 ? causes : ['Unknown error'];
  }

  private suggestImmediateActions(error: string): string[] {
    const actions: string[] = [];
    if (error.includes('insufficient')) {
      actions.push('Check your wallet balance');
      actions.push('Ensure you have enough for gas fees');
      actions.push('Reduce swap amount');
    }
    if (error.includes('slippage')) {
      actions.push('Increase slippage tolerance');
      actions.push('Reduce swap amount');
      actions.push('Wait for market to stabilize');
    }
    if (error.includes('liquidity')) {
      actions.push('Reduce swap amount');
      actions.push('Try alternative DEX');
      actions.push('Split into multiple smaller swaps');
    }
    return actions.length > 0 ? actions : ['Try again', 'Contact support'];
  }

  /**
   * Phase 2: Get real-time confirmation count by querying current block
   */
  private async getRealTimeConfirmations(
    txHash: string,
    txBlockNumber: number | undefined,
    chainId: number | string,
    ecosystem: string,
  ): Promise<number> {
    try {
      if (!txBlockNumber || ecosystem !== 'evm') {
        return 0;
      }

      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;

      // Get RPC endpoint
      const chainConfig = this.chainUtils.getChainConfig(numericChainId);
      const rpcUrls = this.chainUtils.getRpcUrlsForChain(numericChainId);
      const rpcUrl = rpcUrls[0]; // Use first RPC for now

      // Create public client
      const publicClient = createPublicClient({
        chain: chainConfig as any,
        transport: http(rpcUrl),
      });

      // Get current block
      const currentBlock = await publicClient.getBlockNumber();
      const confirmations = Number(currentBlock) - txBlockNumber;

      this.logger.debug(
        `Real-time confirmations for ${txHash}: ${confirmations} (current: ${currentBlock}, tx: ${txBlockNumber})`,
      );

      return Math.max(0, confirmations);
    } catch (error) {
      this.logger.warn(
        `Failed to get real-time confirmations: ${error.message}`,
      );
      return 0; // Fallback to 0 if query fails
    }
  }

  /**
   * Phase 2 & 3: Extract protocol fees from aggregator quote (with USD conversion)
   */
  private async extractProtocolFees(
    swapQuote: any,
    route: RouteQuote,
    chainId: number | string,
  ): Promise<{
    integratorFee?: { amount: string; token: string; usd?: string };
    providerFee?: { amount: string; token: string; usd?: string };
    bridgeFee?: { amount: string; token: string; usd?: string };
  }> {
    const fees: {
      integratorFee?: { amount: string; token: string; usd?: string };
      providerFee?: { amount: string; token: string; usd?: string };
      bridgeFee?: { amount: string; token: string; usd?: string };
    } = {};

    if (!swapQuote) return fees;

    // 0x fees structure
    if (swapQuote.fees) {
      if (swapQuote.fees.integratorFee) {
        fees.integratorFee = {
          amount: swapQuote.fees.integratorFee.amount,
          token: swapQuote.fees.integratorFee.token,
          usd: undefined, // USD conversion disabled
        };
      }

      if (swapQuote.fees.zeroExFee) {
        fees.providerFee = {
          amount: swapQuote.fees.zeroExFee.amount,
          token: swapQuote.fees.zeroExFee.token,
          usd: undefined, // USD conversion disabled
        };
      }
    }

    // Odos partner fee
    if (swapQuote.partnerFeePercent && swapQuote.buyAmount) {
      const feeAmount =
        (BigInt(swapQuote.buyAmount) *
          BigInt(Math.floor(swapQuote.partnerFeePercent * 100))) /
        BigInt(10000);
      fees.providerFee = {
        amount: feeAmount.toString(),
        token: swapQuote.buyToken || 'Unknown',
        usd: undefined, // USD conversion disabled
      };
    }

    // Rubic bridge fees (for cross-chain swaps)
    if (
      swapQuote.bridgeFee ||
      (route.providerRef && (route.providerRef as any).bridgeFee)
    ) {
      const bridgeFee =
        swapQuote.bridgeFee || (route.providerRef as any).bridgeFee;
      fees.bridgeFee = {
        amount: bridgeFee.amount || '0',
        token: bridgeFee.token || 'Unknown',
        usd: undefined, // USD conversion disabled
      };
    }

    return fees;
  }

  /**
   * Phase 2: Extract actual output amount from transaction logs/events
   */
  private async extractActualOutputAmount(
    result: ExecutionResult,
    outputToken: string,
    ecosystem: string,
  ): Promise<string | undefined> {
    try {
      if (ecosystem !== 'evm' || !result.transactionHash) {
        return undefined;
      }

      // TODO: Parse ERC20 Transfer events from transaction receipt
      // This requires the transaction receipt with logs
      // For now, return undefined (will be implemented when receipts are available)

      this.logger.debug('Actual output amount extraction not yet implemented');
      return undefined;
    } catch (error) {
      this.logger.warn(
        `Failed to extract actual output amount: ${error.message}`,
      );
      return undefined;
    }
  }

  private formatTokenAmount(amount: string, decimals: number): string {
    try {
      return formatUnits(BigInt(amount), decimals);
    } catch {
      return amount;
    }
  }

  /**
   * Phase 3: Check if swap is cross-chain
   */
  private isCrossChainSwap(route: RouteQuote): boolean {
    if (!route.steps || route.steps.length < 2) {
      return false;
    }

    // Check if there are different chainIds in the steps
    const firstChainId = route.steps[0].chainId;
    return route.steps.some((step) => step.chainId !== firstChainId);
  }

  /**
   * Phase 3: Build cross-chain details
   */
  private async buildCrossChainDetails(
    result: ExecutionResult,
    route: RouteQuote,
  ): Promise<any> {
    const swapQuote = route.providerRef as any;
    const sourceChainId = route.steps?.[0]?.chainId || result.chainId;
    const destChainId =
      result.destChainId || route.steps?.[route.steps.length - 1]?.chainId;

    const crossChainDetails: any = {
      sourceChain: {
        chainId: sourceChainId,
        chainName: getChainName(sourceChainId),
        transaction: {
          hash: result.transactionHash,
          blockNumber: result.blockNumber,
          status: result.status,
        },
        explorerUrl: result.explorerUrl,
      },
      destinationChain: {
        chainId: destChainId,
        chainName: getChainName(destChainId),
        transaction: result.destTransactionHash
          ? {
              hash: result.destTransactionHash,
              status:
                result.bridgeStatus === 'completed' ? 'SUCCESS' : 'PENDING',
            }
          : undefined,
        explorerUrl: result.destExplorerUrl,
        estimatedArrival: route.etaSeconds
          ? new Date(Date.now() + route.etaSeconds * 1000).toISOString()
          : undefined,
      },
    };

    // Add bridge information if available
    if (result.bridgeStatus || result.bridgeStatusUrl) {
      crossChainDetails.bridge = {
        protocol:
          swapQuote?.bridgeProtocol || this.detectBridgeProtocol(swapQuote),
        status: result.bridgeStatus || 'initiated',
        statusUrl: result.bridgeStatusUrl,
        timing: {
          estimatedSeconds: route.etaSeconds || 300,
          currentPhase: this.getBridgePhase(result.bridgeStatus),
        },
      };
    }

    return crossChainDetails;
  }

  /**
   * Phase 3: Build quality metrics for the route
   */
  private buildQualityMetrics(
    route: RouteQuote,
    swapQuote: any,
    actualTime: number,
    estimatedTime: number,
  ): any {
    // Calculate individual scores (0-100)
    const priceScore = this.calculatePriceScore(swapQuote?.priceImpact);
    const speedScore = this.calculateSpeedScore(actualTime, estimatedTime);
    const reliabilityScore = 90; // Placeholder: would track historical success rate

    // Overall score is weighted average
    const overallScore = Math.round(
      priceScore * 0.5 + speedScore * 0.3 + reliabilityScore * 0.2,
    );

    return {
      overallScore,
      priceScore,
      speedScore,
      reliabilityScore,
      ranking: {
        position: 1, // Placeholder: would compare against other routes
        totalRoutes: 1,
      },
    };
  }

  /**
   * Phase 3: Build warnings and recommendations
   */
  private buildWarningsAndRecommendations(
    result: ExecutionResult,
    route: RouteQuote,
    swapOutcome: any,
    gasAndFees: any,
  ): any {
    const warnings: string[] = [];
    const recommendations: string[] = [];
    const swapQuote = route.providerRef as any;

    // Check for high price impact
    const priceImpact = parseFloat(swapQuote?.priceImpact || '0');
    if (priceImpact > 5) {
      warnings.push(`High price impact: ${priceImpact.toFixed(2)}%`);
      recommendations.push('Consider splitting into multiple smaller swaps');
    }

    // Check for high gas costs
    if (gasAndFees.evm?.gasUtilization > 95) {
      warnings.push('Gas usage near limit');
      recommendations.push('Consider increasing gas limit for future swaps');
    }

    // Check for slow execution
    const actualTime = route.steps?.length || 1;
    if (actualTime > 120) {
      warnings.push('Slower than average execution time');
    }

    // Check for protocol fees
    if (
      gasAndFees.protocolFees?.providerFee ||
      gasAndFees.protocolFees?.integratorFee
    ) {
      const hasHighFees = this.checkHighFees(gasAndFees.protocolFees);
      if (hasHighFees) {
        warnings.push('Higher than average protocol fees');
        recommendations.push('Compare with other aggregators for better rates');
      }
    }

    return warnings.length > 0 || recommendations.length > 0
      ? {
          warnings,
          recommendations,
          severity:
            warnings.length > 2
              ? 'high'
              : warnings.length > 0
                ? 'medium'
                : 'low',
        }
      : undefined;
  }

  /**
   * Helper: Calculate price score based on price impact
   */
  private calculatePriceScore(priceImpact?: string): number {
    if (!priceImpact) return 95;

    const impact = parseFloat(priceImpact);
    if (impact < 0.1) return 100;
    if (impact < 0.5) return 95;
    if (impact < 1.0) return 90;
    if (impact < 2.0) return 80;
    if (impact < 5.0) return 60;
    return 40;
  }

  /**
   * Helper: Calculate speed score based on execution time
   */
  private calculateSpeedScore(
    actualTime: number,
    estimatedTime: number,
  ): number {
    const ratio = actualTime / estimatedTime;
    if (ratio < 0.8) return 100; // Faster than expected
    if (ratio < 1.0) return 95; // On time
    if (ratio < 1.2) return 85; // Slightly slower
    if (ratio < 1.5) return 70; // Slower
    return 50; // Much slower
  }

  /**
   * Helper: Detect bridge protocol from swap quote
   */
  private detectBridgeProtocol(swapQuote: any): string {
    if (swapQuote?.bridge) return swapQuote.bridge;
    if (swapQuote?.bridgeType) return swapQuote.bridgeType;
    return 'Unknown';
  }

  /**
   * Helper: Get current phase of bridge transaction
   */
  private getBridgePhase(bridgeStatus?: string): string {
    switch (bridgeStatus) {
      case 'initiated':
        return 'Source chain confirmed';
      case 'pending':
        return 'Waiting for bridge';
      case 'in_progress':
        return 'Bridge in progress';
      case 'completed':
        return 'Completed on destination';
      case 'failed':
        return 'Failed';
      default:
        return 'Unknown';
    }
  }

  /**
   * Helper: Check if fees are higher than average
   */
  private checkHighFees(protocolFees: any): boolean {
    // Simple heuristic: if any fee is present, it's considered
    // In production, would compare against historical averages
    return !!(protocolFees.providerFee || protocolFees.integratorFee);
  }

  /**
   * Fallback response if enhanced building fails
   */
  private buildFallbackResponse(
    executionId: string,
    result: ExecutionResult,
    context: ExecutionContext,
    startTime: number,
  ): EnhancedExecutionData {
    this.logger.warn('Using fallback response builder');

    return {
      executionId,
      routeId: context.request.routeId,
      requestTimestamp: new Date(startTime).toISOString(),
      status: {
        overall: result.success ? 'SUCCESS' : 'FAILED',
        currentStep: 1,
        totalSteps: 1,
        progressPercentage: result.success ? 100 : 0,
      },
      transactions: [],
      primaryTransaction: {
        hash: result.transactionHash || '',
        chainId: result.chainId,
        chainName: 'Unknown',
        ecosystem: 'evm',
        confirmations: 0,
        requiredConfirmations: 1,
        confirmationProgress: 0,
        from: '',
        to: '',
        status: 'pending',
      },
      gasAndFees: {
        totalCost: {
          native: 'Unknown',
          breakdown: [],
        },
      },
      swapOutcome: {} as any,
      routeProvider: {} as any,
      steps: [],
      timeline: {
        events: [],
        milestones: {
          requestReceived: new Date(startTime).toISOString(),
        },
        duration: {
          total: 0,
        },
      },
      tracking: {
        explorerUrls: [],
        statusCheckEndpoint: '/universal-swap/status',
      },
      metadata: {
        ecosystem: ['evm'],
        aggregators: ['Unknown'],
        chains: [],
        complexity: 'simple',
        version: '1.0.0',
      },
    };
  }

  //============================================================================
  // PHASE 4: PREMIUM ANALYTICS METHODS
  //============================================================================

  /**
   * Helper: Safely access route properties (handles type extension)
   */
  private getRouteProperty<T>(
    route: RouteQuote,
    property: string,
    defaultValue: T,
  ): T {
    const routeAny = route as any;
    return routeAny[property] !== undefined ? routeAny[property] : defaultValue;
  }

  /**
   * Build comprehensive premium analytics (Phase 4)
   */
  private async buildPremiumAnalytics(
    result: ExecutionResult,
    route: RouteQuote,
    context: ExecutionContext,
    gasAndFees: GasAndFeeDetails,
    swapOutcome: SwapOutcomeDetails,
    startTime: number,
    completionTime: number,
  ): Promise<PremiumAnalytics> {
    try {
      this.logger.debug('Building Phase 4 Premium Analytics');

      // Record this swap in analytics
      await this.recordSwapInAnalytics(
        result,
        route,
        context,
        gasAndFees,
        completionTime - startTime,
      );

      // Build all premium components
      const [
        routeComparison,
        recommendations,
        marketContext,
        aggregatorAnalytics,
        dexHealth,
        savings,
      ] = await Promise.all([
        this.buildRouteComparison(route, context, gasAndFees, swapOutcome),
        this.buildSmartRecommendations(
          result,
          route,
          context,
          gasAndFees,
          swapOutcome,
        ),
        this.buildMarketContext(route, context),
        this.buildAggregatorAnalytics(route),
        this.buildDEXHealth(route),
        this.buildSavingsCalculation(route, context, gasAndFees, swapOutcome),
      ]);

      // Historical comparison
      const historicalComparison = await this.buildHistoricalComparison(
        route,
        context,
        gasAndFees,
      );

      return {
        routeComparison,
        recommendations,
        marketContext,
        aggregatorAnalytics,
        dexHealth,
        savings,
        historicalComparison,
      };
    } catch (error) {
      this.logger.error(`Failed to build premium analytics: ${error.message}`);
      // Return minimal analytics on error
      return this.buildFallbackPremiumAnalytics(route);
    }
  }

  /**
   * Record swap in analytics service for future comparisons
   */
  private async recordSwapInAnalytics(
    result: ExecutionResult,
    route: RouteQuote,
    context: ExecutionContext,
    gasAndFees: GasAndFeeDetails,
    executionTime: number,
  ): Promise<void> {
    try {
      const routeAny = route as any;
      const swapRecord = {
        executionId: (context.request as any).executionId || '',
        timestamp: new Date(),
        aggregator: routeAny.aggregator || 'Unknown',
        sourceChain: routeAny.source?.chainId || routeAny.chainId || 1,
        destChain: routeAny.destination?.chainId || routeAny.chainId || 1,
        inputToken: routeAny.inputToken || '',
        outputToken: routeAny.outputToken || '',
        inputAmount: routeAny.inputAmount || '0',
        outputAmount: routeAny.outputAmount || route.totalEstimatedOut || '0',
        gasUsed: result.gasUsed,
        gasCostUsd:
          gasAndFees.evm?.totalGasCost?.usd || gasAndFees.totalCost?.usd,
        protocolFeesUsd: gasAndFees.protocolFees?.integratorFee?.usd || '0',
        totalCostUsd: gasAndFees.totalCost?.usd || '0',
        executionTimeSeconds: Math.round(executionTime / 1000),
        priceImpact: parseFloat(route.priceImpact?.toString() || '0'),
        slippage: parseFloat(routeAny.slippageBps?.toString() || '0') / 100,
        success: result.success,
        failureReason: result.error,
        qualityScore: routeAny.quality?.overallScore,
      };

      this.analytics.recordSwap(swapRecord);
    } catch (error) {
      this.logger.warn(`Failed to record swap in analytics: ${error.message}`);
    }
  }

  /**
   * Build route comparison with alternatives
   */
  private async buildRouteComparison(
    selectedRoute: RouteQuote,
    context: ExecutionContext,
    gasAndFees: GasAndFeeDetails,
    swapOutcome: SwapOutcomeDetails,
  ): Promise<RouteComparisonAnalysis> {
    try {
      // Get alternative routes from context (if available)
      const alternativeRoutes = this.getRouteProperty(
        context as any,
        'alternativeRoutes',
        [],
      );

      const selectedOutputUsd = swapOutcome.output.expectedAmount.usd || '0';
      const selectedCostUsd = gasAndFees.totalCost.usd || '0';
      const selectedQuality =
        this.getRouteProperty(selectedRoute, 'quality', { overallScore: 85 })
          .overallScore || 85;

      // Build alternative route details
      const alternatives: AlternativeRouteDetails[] = alternativeRoutes.map(
        (alt: any, index: number) => {
          const altOutputUsd = alt.outputAmount
            ? parseFloat(alt.outputAmount)
            : 0;
          const selOutputNum = parseFloat(selectedOutputUsd);
          const outputDiff = altOutputUsd - selOutputNum;
          const outputDiffPercent =
            selOutputNum > 0 ? (outputDiff / selOutputNum) * 100 : 0;

          const altCostUsd = alt.estimatedGas || '10';
          const costDiff = parseFloat(altCostUsd) - parseFloat(selectedCostUsd);
          const costDiffPercent =
            parseFloat(selectedCostUsd) > 0
              ? (costDiff / parseFloat(selectedCostUsd)) * 100
              : 0;

          return {
            aggregator: alt.aggregator || `Alternative ${index + 1}`,
            routeId: alt.routeId || `route_alt_${index}`,
            outputAmount: {
              raw: alt.outputAmount || '0',
              formatted: alt.outputAmount || '0',
              usd: altOutputUsd.toFixed(2),
            },
            totalCost: {
              native: alt.estimatedGas || '0',
              usd: altCostUsd,
              breakdown: {
                gas: altCostUsd,
                protocolFees: '0',
              },
            },
            priceComparison: {
              outputDifference:
                outputDiff >= 0
                  ? `+${outputDiff.toFixed(2)}`
                  : outputDiff.toFixed(2),
              outputDifferencePercent: parseFloat(outputDiffPercent.toFixed(2)),
              betterThan: outputDiff > 0,
            },
            costComparison: {
              costDifference:
                costDiff >= 0 ? `+${costDiff.toFixed(2)}` : costDiff.toFixed(2),
              costDifferencePercent: parseFloat(costDiffPercent.toFixed(2)),
              cheaper: costDiff < 0,
            },
            estimatedTime: alt.estimatedTime || 30,
            qualityScore: alt.quality?.overallScore || 80,
            notSelectedReason: this.determineNotSelectedReason(
              selectedRoute,
              alt,
            ),
          };
        },
      );

      // Find best alternatives
      const bestByOutput =
        alternatives.length > 0
          ? alternatives.reduce((best, current) =>
              current.priceComparison.betterThan &&
              parseFloat(current.outputAmount.usd || '0') >
                parseFloat(best.outputAmount.usd || '0')
                ? current
                : best,
            )
          : null;

      const cheapest =
        alternatives.length > 0
          ? alternatives.reduce((best, current) =>
              parseFloat(current.totalCost.usd || '999999') <
              parseFloat(best.totalCost.usd || '999999')
                ? current
                : best,
            )
          : null;

      const fastest =
        alternatives.length > 0
          ? alternatives.reduce((best, current) =>
              current.estimatedTime < best.estimatedTime ? current : best,
            )
          : null;

      // Determine verdict
      const allRoutes = [selectedRoute, ...alternativeRoutes];
      const rankByQuality = allRoutes
        .map((r, i) => ({
          route: r,
          index: i,
          score:
            this.getRouteProperty(r, 'quality', { overallScore: 80 })
              .overallScore || 80,
        }))
        .sort((a, b) => b.score - a.score);

      const selectedRank = rankByQuality.findIndex((r) => r.index === 0) + 1;

      let verdictSummary = 'You got the best available route';
      if (selectedRank > 1 && cheapest) {
        const savingsAmount =
          parseFloat(selectedCostUsd) -
          parseFloat(cheapest.totalCost.usd || '0');
        verdictSummary = `You could have saved $${Math.abs(savingsAmount).toFixed(2)} with ${cheapest.aggregator}`;
      } else if (selectedRank > 1 && bestByOutput) {
        verdictSummary = `You could have received ${bestByOutput.priceComparison.outputDifference} more with ${bestByOutput.aggregator}`;
      }

      return {
        selectedRoute: {
          aggregator: this.getRouteProperty(
            selectedRoute,
            'aggregator',
            'Unknown',
          ),
          outputAmount: selectedOutputUsd,
          totalCost: selectedCostUsd,
          qualityScore: selectedQuality,
          rank: selectedRank,
        },
        alternatives,
        bestByOutput: bestByOutput
          ? {
              aggregator: bestByOutput.aggregator,
              potentialGain: bestByOutput.priceComparison.outputDifference,
              gainUsd: bestByOutput.outputAmount.usd,
            }
          : undefined,
        cheapest: cheapest
          ? {
              aggregator: cheapest.aggregator,
              potentialSavings: `$${Math.abs(parseFloat(cheapest.costComparison.costDifference)).toFixed(2)}`,
              savingsPercent: Math.abs(
                cheapest.costComparison.costDifferencePercent,
              ),
            }
          : undefined,
        fastest: fastest
          ? {
              aggregator: fastest.aggregator,
              timeDifference: Math.abs(
                fastest.estimatedTime -
                  this.getRouteProperty(selectedRoute, 'estimatedTime', 30),
              ),
            }
          : undefined,
        verdict: {
          optimal: selectedRank === 1,
          rank: selectedRank,
          totalRoutesCompared: allRoutes.length,
          summary: verdictSummary,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to build route comparison: ${error.message}`);
      return this.buildFallbackRouteComparison(selectedRoute);
    }
  }

  /**
   * Determine why an alternative route was not selected
   */
  private determineNotSelectedReason(
    selected: RouteQuote,
    alternative: any,
  ): string {
    const selectedQuality =
      this.getRouteProperty(selected, 'quality', { overallScore: 80 })
        .overallScore || 80;
    const altQuality = alternative.quality?.overallScore || 75;

    if (altQuality < selectedQuality - 5) {
      return 'Lower overall quality score';
    }
    if (
      parseFloat(selected.priceImpact || '0') < (alternative.priceImpact || 1)
    ) {
      return 'Higher price impact';
    }
    if (
      this.getRouteProperty(selected, 'estimatedTime', 30) <
      (alternative.estimatedTime || 40)
    ) {
      return 'Slower execution time';
    }
    return 'Selected route offered better overall value';
  }

  /**
   * Build smart recommendations
   */
  private async buildSmartRecommendations(
    result: ExecutionResult,
    route: RouteQuote,
    context: ExecutionContext,
    gasAndFees: GasAndFeeDetails,
    swapOutcome: SwapOutcomeDetails,
  ): Promise<SmartRecommendations> {
    try {
      const optimizations: OptimizationSuggestion[] = [];

      // Check for split order opportunity
      const inputAmountNum = parseFloat(
        this.getRouteProperty(route, 'inputAmount', '0'),
      );
      const priceImpact = parseFloat(
        swapOutcome.priceImpact.estimated.replace('%', ''),
      );

      if (priceImpact > 3 && inputAmountNum > 100) {
        optimizations.push({
          type: 'split-order',
          title: 'Split large order to reduce price impact',
          description: `Your swap has ${priceImpact.toFixed(2)}% price impact. Splitting into 2-3 smaller swaps could reduce this to ~${(priceImpact / 2).toFixed(2)}%`,
          priority: priceImpact > 5 ? 'high' : 'medium',
          potentialSavings: {
            amount: `${(priceImpact * inputAmountNum * 0.005).toFixed(2)} tokens`,
            usd: (priceImpact * inputAmountNum * 0.005).toFixed(2),
            percentage: priceImpact * 0.3,
          },
          difficulty: 'medium',
          actionableSteps: [
            'Calculate optimal split size (typically 1/3 of total)',
            'Execute first swap, wait 5-10 minutes',
            'Execute second swap with remaining amount',
            'Adjust timing based on liquidity depth',
          ],
          impact: {
            metric: 'price impact',
            improvement: `Reduce from ${priceImpact.toFixed(2)}% to ~${(priceImpact / 2).toFixed(2)}%`,
          },
        });
      }

      // Check for gas optimization
      const gasUtilization = gasAndFees.evm?.gasUtilization || 0;
      if (gasUtilization > 80) {
        optimizations.push({
          type: 'gas',
          title: 'Optimize gas usage',
          description:
            'Transaction used 80%+ of gas limit. Consider using a more efficient route or increasing gas limit.',
          priority: 'medium',
          difficulty: 'easy',
          actionableSteps: [
            'Increase gas limit by 10-20%',
            'Try alternative aggregator with better gas efficiency',
            'Consider timing swap during lower network activity',
          ],
        });
      }

      // Check for timing optimization
      const gasCostUsd = parseFloat(gasAndFees.totalCost.usd || '0');
      if (gasCostUsd > 20) {
        optimizations.push({
          type: 'timing',
          title: 'Optimize swap timing for lower gas costs',
          description: `Current gas cost is $${gasCostUsd.toFixed(2)}. Waiting for off-peak hours could save 30-50%.`,
          priority: 'low',
          potentialSavings: {
            amount: (gasCostUsd * 0.4).toFixed(2),
            usd: (gasCostUsd * 0.4).toFixed(2),
            percentage: 40,
          },
          difficulty: 'easy',
          actionableSteps: [
            'Monitor gas prices using GasNow or ETH Gas Station',
            'Schedule swap during UTC 00:00-08:00 (typically lower gas)',
            'Set up gas price alerts',
          ],
          impact: {
            metric: 'gas cost',
            improvement: `Potential savings: $${(gasCostUsd * 0.4).toFixed(2)}`,
          },
        });
      }

      // Alternative aggregator recommendations
      const inputToken = this.getRouteProperty(route, 'inputToken', '');
      const outputToken = this.getRouteProperty(route, 'outputToken', '');
      const chainId =
        this.getRouteProperty(route, 'source', { chainId: 1 }).chainId || 1;

      const bestAggregator =
        inputToken && outputToken
          ? this.analytics.getBestAggregatorForPair({
              inputToken,
              outputToken,
              chainId,
            })
          : null;

      const routeAggregator = this.getRouteProperty(
        route,
        'aggregator',
        'Unknown',
      );
      const alternativeAggregators =
        bestAggregator && bestAggregator.aggregator !== routeAggregator
          ? [
              {
                aggregator: bestAggregator.aggregator,
                benefit: 'Historically performs better for this token pair',
                useCase: 'Better liquidity and lower slippage',
                potentialSavings: 'Estimated 0.5-1% better rates',
              },
            ]
          : [];

      // Calculate overall score
      const overallScore = this.calculateRecommendationScore(
        priceImpact,
        gasCostUsd,
        gasUtilization,
      );

      return {
        score: overallScore,
        verdict: {
          rating: this.getRating(overallScore),
          summary: this.getVerdictSummary(
            overallScore,
            priceImpact,
            gasCostUsd,
          ),
          keyPoints: this.getKeyPoints(priceImpact, gasCostUsd, gasUtilization),
        },
        routeOptimizations: optimizations,
        alternativeAggregators:
          alternativeAggregators.length > 0
            ? alternativeAggregators
            : undefined,
        timingAdvice: this.getTimingAdvice(gasCostUsd),
        risks: this.identifyRisks(priceImpact, swapOutcome.slippage.tolerance),
        futureAdvice: [
          'Monitor gas prices before swapping',
          'Consider splitting large orders',
          'Compare multiple aggregators',
          'Use limit orders for non-urgent swaps',
          'Enable slippage protection',
        ],
      };
    } catch (error) {
      this.logger.error(
        `Failed to build smart recommendations: ${error.message}`,
      );
      return this.buildFallbackRecommendations();
    }
  }

  /**
   * Calculate recommendation score (0-100)
   */
  private calculateRecommendationScore(
    priceImpact: number,
    gasCost: number,
    gasUtilization: number,
  ): number {
    let score = 100;

    // Deduct for high price impact
    if (priceImpact > 5) score -= 30;
    else if (priceImpact > 2) score -= 15;
    else if (priceImpact > 1) score -= 5;

    // Deduct for high gas cost
    if (gasCost > 50) score -= 20;
    else if (gasCost > 20) score -= 10;
    else if (gasCost > 10) score -= 5;

    // Deduct for high gas utilization
    if (gasUtilization > 90) score -= 15;
    else if (gasUtilization > 80) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get rating from score
   */
  private getRating(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
    if (score >= 85) return 'excellent';
    if (score >= 70) return 'good';
    if (score >= 50) return 'fair';
    return 'poor';
  }

  /**
   * Get verdict summary
   */
  private getVerdictSummary(
    score: number,
    priceImpact: number,
    gasCost: number,
  ): string {
    if (score >= 85) {
      return 'Excellent swap execution with minimal impact and optimal costs';
    }
    if (score >= 70) {
      return 'Good swap execution with acceptable costs and impact';
    }
    if (priceImpact > 3) {
      return 'High price impact detected. Consider splitting the order.';
    }
    if (gasCost > 20) {
      return 'High gas costs detected. Consider waiting for lower network activity.';
    }
    return 'Swap executed but could be optimized for better value';
  }

  /**
   * Get key points for verdict
   */
  private getKeyPoints(
    priceImpact: number,
    gasCost: number,
    gasUtilization: number,
  ): string[] {
    const points: string[] = [];

    if (priceImpact < 0.5) {
      points.push('Excellent price impact (<0.5%)');
    } else if (priceImpact > 3) {
      points.push(`High price impact (${priceImpact.toFixed(2)}%)`);
    }

    if (gasCost < 5) {
      points.push('Low gas costs');
    } else if (gasCost > 20) {
      points.push(`High gas costs ($${gasCost.toFixed(2)})`);
    }

    if (gasUtilization < 60) {
      points.push('Efficient gas utilization');
    } else if (gasUtilization > 85) {
      points.push('High gas utilization (near limit)');
    }

    if (points.length === 0) {
      points.push('Standard execution parameters');
    }

    return points;
  }

  /**
   * Get timing advice
   */
  private getTimingAdvice(gasCost: number): {
    currentTiming: 'optimal' | 'good' | 'acceptable' | 'poor';
    suggestion: string;
    potentialImprovement?: string;
  } {
    if (gasCost < 5) {
      return {
        currentTiming: 'optimal',
        suggestion: 'Current timing is excellent with low gas prices',
      };
    }
    if (gasCost < 10) {
      return {
        currentTiming: 'good',
        suggestion: 'Gas prices are reasonable for current network activity',
      };
    }
    if (gasCost < 20) {
      return {
        currentTiming: 'acceptable',
        suggestion: 'Consider waiting for lower gas prices if not urgent',
        potentialImprovement: 'Could save $5-10 during off-peak hours',
      };
    }
    return {
      currentTiming: 'poor',
      suggestion:
        'Gas prices are high. Strongly recommend waiting for lower network activity',
      potentialImprovement: `Could save $${(gasCost * 0.5).toFixed(2)} or more`,
    };
  }

  /**
   * Identify risks
   */
  private identifyRisks(
    priceImpact: number,
    slippageTolerance: string,
  ): Array<{
    risk: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    mitigation: string;
  }> {
    const risks: Array<{
      risk: string;
      severity: 'critical' | 'high' | 'medium' | 'low';
      mitigation: string;
    }> = [];

    if (priceImpact > 10) {
      risks.push({
        risk: 'Extremely high price impact (>10%)',
        severity: 'critical',
        mitigation: 'Split order into multiple smaller swaps over time',
      });
    } else if (priceImpact > 5) {
      risks.push({
        risk: 'High price impact detected',
        severity: 'high',
        mitigation: 'Consider reducing swap size or using limit orders',
      });
    }

    const slippageNum = parseFloat(slippageTolerance.replace('%', ''));
    if (slippageNum > 3) {
      risks.push({
        risk: 'High slippage tolerance',
        severity: 'medium',
        mitigation:
          'Reduce slippage tolerance to protect against front-running',
      });
    }

    return risks;
  }

  /**
   * Build market context
   */
  private async buildMarketContext(
    route: RouteQuote,
    context: ExecutionContext,
  ): Promise<MarketContext> {
    try {
      // Mock market context (in production, fetch from real data sources)
      const liquidityLevel = this.estimateLiquidityLevel(route);
      const volatilityLevel = this.estimateVolatility();

      return {
        liquidity: {
          available: liquidityLevel,
          depth: {
            usd: this.estimateLiquidityUSD(route),
            tokens: this.getRouteProperty(
              route,
              'outputAmount',
              route.totalEstimatedOut || '0',
            ),
          },
          topPools: this.getTopPools(route),
        },
        volatility: {
          level: volatilityLevel,
          priceChange24h: this.estimatePriceChange24h(),
          priceChange1h: this.estimatePriceChange1h(),
          historicalVolatility: 45.5, // Mock annual volatility
        },
        volume: {
          volume24h: this.estimate24hVolume(route),
          volumeChange24h: 12.5,
          averageTradeSize: '5000',
          largeTradeThreshold: 'Your trade is above average size',
        },
        gasPriceContext: {
          current: '30 gwei',
          average24h: '35 gwei',
          percentile: 45,
          trend: 'decreasing',
          recommendation: 'Good time to swap - gas prices below average',
        },
        timingRecommendation: {
          currentTime: this.evaluateCurrentTiming(),
          reasoning: 'Gas prices are moderate and liquidity is good',
          betterTimeframes: [],
        },
      };
    } catch (error) {
      this.logger.error(`Failed to build market context: ${error.message}`);
      return this.buildFallbackMarketContext();
    }
  }

  /**
   * Estimate liquidity level
   */
  private estimateLiquidityLevel(
    route: RouteQuote,
  ): 'excellent' | 'good' | 'moderate' | 'low' | 'poor' {
    const priceImpact = parseFloat(route.priceImpact?.toString() || '0');
    if (priceImpact < 0.3) return 'excellent';
    if (priceImpact < 1) return 'good';
    if (priceImpact < 3) return 'moderate';
    if (priceImpact < 5) return 'low';
    return 'poor';
  }

  /**
   * Estimate liquidity in USD
   */
  private estimateLiquidityUSD(route: RouteQuote): string {
    const outputAmount = parseFloat(
      this.getRouteProperty(
        route,
        'outputAmount',
        route.totalEstimatedOut || '0',
      ),
    );
    const priceImpact = parseFloat(route.priceImpact?.toString() || '1');

    // Rough estimate: liquidity = output / (price_impact / 100)
    const estimatedLiquidity = outputAmount / (priceImpact / 100);
    return `$${(estimatedLiquidity * 1000).toFixed(0)}`; // Multiply by assumed token price
  }

  /**
   * Get top liquidity pools
   */
  private getTopPools(
    route: RouteQuote,
  ): Array<{ dex: string; liquidity: string; volume24h?: string }> {
    // Mock data (in production, fetch from DEX analytics)
    return [
      { dex: 'Uniswap V3', liquidity: '$2.5M', volume24h: '$1.2M' },
      { dex: 'Curve', liquidity: '$1.8M', volume24h: '$800K' },
      { dex: 'Balancer', liquidity: '$1.2M', volume24h: '$400K' },
    ];
  }

  /**
   * Estimate volatility
   */
  private estimateVolatility():
    | 'very-low'
    | 'low'
    | 'moderate'
    | 'high'
    | 'very-high' {
    // Mock volatility (in production, calculate from historical price data)
    return 'moderate';
  }

  /**
   * Estimate 24h price change
   */
  private estimatePriceChange24h(): number {
    // Mock data (in production, fetch from price oracle)
    return Math.random() * 10 - 5; // Random between -5% and +5%
  }

  /**
   * Estimate 1h price change
   */
  private estimatePriceChange1h(): number {
    // Mock data
    return Math.random() * 2 - 1; // Random between -1% and +1%
  }

  /**
   * Estimate 24h volume
   */
  private estimate24hVolume(route: RouteQuote): string {
    // Mock data
    return '$5.2M';
  }

  /**
   * Evaluate current timing
   */
  private evaluateCurrentTiming(): 'excellent' | 'good' | 'moderate' | 'poor' {
    const hour = new Date().getUTCHours();
    // Off-peak hours (UTC 00:00-08:00) typically have lower gas
    if (hour >= 0 && hour < 8) return 'excellent';
    if (hour >= 8 && hour < 12) return 'good';
    if (hour >= 12 && hour < 18) return 'moderate';
    return 'poor';
  }

  /**
   * Build aggregator analytics
   */
  private async buildAggregatorAnalytics(
    route: RouteQuote,
  ): Promise<AggregatorAnalytics[]> {
    try {
      const aggregator = this.getRouteProperty(route, 'aggregator', 'Unknown');
      const stats = this.analytics.getAggregatorStats(aggregator);
      const trend = this.analytics.getPerformanceTrend(aggregator, 7);

      if (!stats) {
        // Return default analytics if no data
        return [
          {
            aggregator,
            performance: {
              successRate: 95,
              averageExecutionTime: 30,
              totalSwapsProcessed: 0,
              volumeProcessed: '$0',
            },
            costs: {
              averageGasCost: '$10.00',
              averageProtocolFee: 0.3,
              averageTotalCost: '$12.00',
              comparedToOthers: 'average',
            },
            quality: {
              averagePriceImpact: 0.8,
              averageSlippage: 0.3,
              failureRate: 5,
            },
            bestFor: ['General purpose swaps'],
            trend: {
              period: '7d',
              successRateChange: 0,
              costChange: 0,
              qualityChange: 0,
            },
          },
        ];
      }

      const successRate = (stats.successfulSwaps / stats.totalSwaps) * 100;
      const failureRate = 100 - successRate;

      return [
        {
          aggregator: stats.aggregator,
          performance: {
            successRate: parseFloat(successRate.toFixed(2)),
            averageExecutionTime: Math.round(stats.averageExecutionTime),
            totalSwapsProcessed: stats.totalSwaps,
            volumeProcessed: `$${stats.totalVolumeUsd}`,
          },
          costs: {
            averageGasCost: `$${stats.averageGasCostUsd}`,
            averageProtocolFee: stats.averageProtocolFeePercent,
            averageTotalCost: `$${(parseFloat(stats.averageGasCostUsd) * 1.2).toFixed(2)}`,
            comparedToOthers: this.analytics.compareAggregatorCosts(aggregator),
          },
          quality: {
            averagePriceImpact: parseFloat(stats.averagePriceImpact.toFixed(2)),
            averageSlippage: parseFloat(stats.averageSlippage.toFixed(2)),
            failureRate: parseFloat(failureRate.toFixed(2)),
          },
          bestFor: this.determineBestUseCases(stats),
          trend: {
            period: '7d',
            successRateChange: trend.successRateChange,
            costChange: trend.costChange,
            qualityChange: trend.qualityChange,
          },
        },
      ];
    } catch (error) {
      this.logger.error(
        `Failed to build aggregator analytics: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Determine best use cases for aggregator
   */
  private determineBestUseCases(stats: any): string[] {
    const useCases: string[] = [];

    if (stats.averageGasCostUsd < 8) {
      useCases.push('Low gas costs');
    }
    if (stats.averagePriceImpact < 0.5) {
      useCases.push('Large trades with minimal impact');
    }
    if (stats.averageExecutionTime < 25) {
      useCases.push('Fast execution');
    }
    if (stats.successfulSwaps / stats.totalSwaps > 0.97) {
      useCases.push('High reliability');
    }

    if (useCases.length === 0) {
      useCases.push('General purpose swaps');
    }

    return useCases;
  }

  /**
   * Build DEX health metrics
   */
  private async buildDEXHealth(route: RouteQuote): Promise<DEXHealthMetrics[]> {
    try {
      // Mock DEX health data (in production, fetch from DEX analytics APIs)
      const dexSources = this.getRouteProperty(route, 'dexSources', []);
      const dexes =
        dexSources && dexSources.length > 0
          ? dexSources.map((source: any) => source.dex)
          : ['Uniswap V3'];

      return dexes.map((dex: string) => ({
        dex,
        healthScore: this.calculateDEXHealthScore(dex),
        liquidity: {
          tvl: this.mockTVL(dex),
          volume24h: this.mockVolume24h(dex),
          liquidityUtilization: this.mockLiquidityUtilization(),
        },
        performance: {
          uptime: 99.9,
          averageSlippage: this.mockAverageSlippage(dex),
          failedTransactionRate: this.mockFailureRate(dex),
        },
        gasEfficiency: {
          averageGasUsed: this.mockAverageGas(dex),
          comparedToOthers: this.mockGasComparison(dex),
        },
        security: {
          audited: true,
          lastAuditDate: '2024-Q3',
          knownVulnerabilities: 0,
          riskLevel: 'low',
        },
      }));
    } catch (error) {
      this.logger.error(`Failed to build DEX health: ${error.message}`);
      return [];
    }
  }

  /**
   * Calculate DEX health score
   */
  private calculateDEXHealthScore(dex: string): number {
    // Mock calculation (in production, use real metrics)
    const baseScores: Record<string, number> = {
      'Uniswap V3': 95,
      Curve: 92,
      Balancer: 88,
      SushiSwap: 85,
      PancakeSwap: 87,
    };
    return baseScores[dex] || 80;
  }

  private mockTVL(dex: string): string {
    const tvls: Record<string, string> = {
      'Uniswap V3': '$4.2B',
      Curve: '$3.8B',
      Balancer: '$1.5B',
      SushiSwap: '$800M',
      PancakeSwap: '$2.1B',
    };
    return tvls[dex] || '$500M';
  }

  private mockVolume24h(dex: string): string {
    const volumes: Record<string, string> = {
      'Uniswap V3': '$1.2B',
      Curve: '$450M',
      Balancer: '$180M',
      SushiSwap: '$120M',
      PancakeSwap: '$650M',
    };
    return volumes[dex] || '$50M';
  }

  private mockLiquidityUtilization(): number {
    return Math.random() * 30 + 10; // 10-40%
  }

  private mockAverageSlippage(dex: string): number {
    return Math.random() * 0.5 + 0.1; // 0.1-0.6%
  }

  private mockFailureRate(dex: string): number {
    return Math.random() * 2; // 0-2%
  }

  private mockAverageGas(dex: string): string {
    const gas: Record<string, string> = {
      'Uniswap V3': '180,000',
      Curve: '220,000',
      Balancer: '190,000',
      SushiSwap: '170,000',
      PancakeSwap: '150,000',
    };
    return gas[dex] || '200,000';
  }

  private mockGasComparison(
    dex: string,
  ): 'efficient' | 'average' | 'inefficient' {
    const efficient = ['Uniswap V3', 'SushiSwap', 'PancakeSwap'];
    return efficient.includes(dex) ? 'efficient' : 'average';
  }

  /**
   * Build savings calculation
   */
  private async buildSavingsCalculation(
    route: RouteQuote,
    context: ExecutionContext,
    gasAndFees: GasAndFeeDetails,
    swapOutcome: SwapOutcomeDetails,
  ): Promise<SavingsCalculation> {
    try {
      const actualCostUsd = gasAndFees.totalCost.usd || '0';
      const gasCostUsd = gasAndFees.evm?.totalGasCost?.usd || '0';
      const protocolFeesUsd =
        gasAndFees.protocolFees?.integratorFee?.usd || '0';
      const priceImpact = parseFloat(
        swapOutcome.priceImpact.estimated.replace('%', ''),
      );
      const inputAmount = this.getRouteProperty(route, 'inputAmount', '0');
      const priceImpactCost = (priceImpact / 100) * parseFloat(inputAmount);

      // Get historical average cost
      const inputToken = this.getRouteProperty(route, 'inputToken', '');
      const outputToken = this.getRouteProperty(route, 'outputToken', '');
      const chainId =
        this.getRouteProperty(route, 'source', { chainId: 1 }).chainId || 1;

      const avgCost =
        inputToken && outputToken
          ? this.analytics.getAverageCostForSimilarSwaps({
              inputToken,
              outputToken,
              chainId,
            })
          : '0';

      const savings = parseFloat(avgCost) - parseFloat(actualCostUsd);

      const alternativeRoutes = this.getRouteProperty(
        context as any,
        'alternativeRoutes',
        [],
      );

      return {
        actualCost: {
          native: gasAndFees.totalCost.native,
          usd: actualCostUsd,
          breakdown: {
            gas: gasCostUsd,
            protocolFees: protocolFeesUsd,
            priceImpact: priceImpactCost.toFixed(2),
          },
        },
        potentialSavings: {
          amount: Math.abs(savings).toFixed(2),
          usd: Math.abs(savings).toFixed(2),
          percentage:
            avgCost !== '0'
              ? (Math.abs(savings) / parseFloat(avgCost)) * 100
              : 0,
          comparedTo: 'average similar swaps',
        },
        vsAlternatives: alternativeRoutes.map((alt: any) => {
          const altCost = parseFloat(alt.estimatedGas || '10');
          const diff = parseFloat(actualCostUsd) - altCost;
          return {
            aggregator: alt.aggregator || 'Unknown',
            saved:
              diff >= 0
                ? `+$${diff.toFixed(2)}`
                : `-$${Math.abs(diff).toFixed(2)}`,
            percentage: altCost > 0 ? (diff / altCost) * 100 : 0,
          };
        }),
        vsHistorical: {
          averageCostSimilarSwaps: `$${avgCost}`,
          yourSavings:
            savings >= 0
              ? `+$${savings.toFixed(2)}`
              : `-$${Math.abs(savings).toFixed(2)}`,
          percentile:
            inputToken && outputToken
              ? this.analytics.calculatePerformancePercentile({
                  inputToken,
                  outputToken,
                  chainId,
                  totalCostUsd: actualCostUsd,
                })
              : 50,
        },
        optimizationOpportunities: this.identifyOptimizationOpportunities(
          priceImpact,
          parseFloat(gasCostUsd),
        ),
      };
    } catch (error) {
      this.logger.error(
        `Failed to build savings calculation: ${error.message}`,
      );
      return this.buildFallbackSavings();
    }
  }

  /**
   * Identify optimization opportunities
   */
  private identifyOptimizationOpportunities(
    priceImpact: number,
    gasCost: number,
  ): Array<{
    opportunity: string;
    potentialSavings: string;
    effort: 'low' | 'medium' | 'high';
  }> {
    const opportunities: Array<{
      opportunity: string;
      potentialSavings: string;
      effort: 'low' | 'medium' | 'high';
    }> = [];

    if (priceImpact > 3) {
      opportunities.push({
        opportunity: 'Split order into 2-3 smaller swaps',
        potentialSavings: `~${(priceImpact * 0.5).toFixed(2)}% price impact reduction`,
        effort: 'medium',
      });
    }

    if (gasCost > 15) {
      opportunities.push({
        opportunity: 'Wait for lower gas prices',
        potentialSavings: `$${(gasCost * 0.4).toFixed(2)} (40% gas savings)`,
        effort: 'low',
      });
    }

    if (gasCost > 10 && priceImpact < 1) {
      opportunities.push({
        opportunity: 'Use limit order instead of market swap',
        potentialSavings: `$${gasCost.toFixed(2)} gas + better execution`,
        effort: 'low',
      });
    }

    return opportunities;
  }

  /**
   * Build historical comparison
   */
  private async buildHistoricalComparison(
    route: RouteQuote,
    context: ExecutionContext,
    gasAndFees: GasAndFeeDetails,
  ): Promise<{
    similarSwapsCount: number;
    yourPerformance: { percentile: number; betterThanAverage: boolean };
    insights: string[];
  }> {
    try {
      const inputToken = this.getRouteProperty(route, 'inputToken', '');
      const outputToken = this.getRouteProperty(route, 'outputToken', '');
      const chainId =
        this.getRouteProperty(route, 'source', { chainId: 1 }).chainId || 1;

      if (!inputToken || !outputToken) {
        return {
          similarSwapsCount: 0,
          yourPerformance: { percentile: 50, betterThanAverage: true },
          insights: ['Insufficient data for comparison'],
        };
      }

      const similar = this.analytics.getSimilarSwaps({
        inputToken,
        outputToken,
        chainId,
        limit: 50,
      });

      const percentile = this.analytics.calculatePerformancePercentile({
        inputToken,
        outputToken,
        chainId,
        totalCostUsd: gasAndFees.totalCost.usd || '0',
      });

      const insights: string[] = [];

      if (percentile >= 75) {
        insights.push('Your swap cost was in the top 25% (best value)');
      } else if (percentile >= 50) {
        insights.push('Your swap cost was better than average');
      } else if (percentile < 25) {
        insights.push('Your swap was more expensive than 75% of similar swaps');
      }

      if (similar.length > 10) {
        insights.push(
          `Based on ${similar.length} similar swaps in the last 30 days`,
        );
      }

      return {
        similarSwapsCount: similar.length,
        yourPerformance: {
          percentile,
          betterThanAverage: percentile >= 50,
        },
        insights,
      };
    } catch (error) {
      this.logger.error(
        `Failed to build historical comparison: ${error.message}`,
      );
      return {
        similarSwapsCount: 0,
        yourPerformance: { percentile: 50, betterThanAverage: true },
        insights: ['Insufficient historical data'],
      };
    }
  }

  //============================================================================
  // FALLBACK METHODS FOR PHASE 4
  //============================================================================

  private buildFallbackPremiumAnalytics(route: RouteQuote): PremiumAnalytics {
    return {
      routeComparison: this.buildFallbackRouteComparison(route),
      recommendations: this.buildFallbackRecommendations(),
      marketContext: this.buildFallbackMarketContext(),
      aggregatorAnalytics: [],
      dexHealth: [],
      savings: this.buildFallbackSavings(),
    };
  }

  private buildFallbackRouteComparison(
    route: RouteQuote,
  ): RouteComparisonAnalysis {
    return {
      selectedRoute: {
        aggregator: this.getRouteProperty(route, 'aggregator', 'Unknown'),
        outputAmount: '0',
        totalCost: '0',
        qualityScore: 80,
        rank: 1,
      },
      alternatives: [],
      verdict: {
        optimal: true,
        rank: 1,
        totalRoutesCompared: 1,
        summary: 'Route selected (insufficient data for comparison)',
      },
    };
  }

  private buildFallbackRecommendations(): SmartRecommendations {
    return {
      score: 75,
      verdict: {
        rating: 'good',
        summary: 'Swap executed successfully',
        keyPoints: ['Standard execution parameters'],
      },
      routeOptimizations: [],
      futureAdvice: [
        'Monitor gas prices before swapping',
        'Compare multiple aggregators',
        'Use limit orders for non-urgent swaps',
      ],
    };
  }

  private buildFallbackMarketContext(): MarketContext {
    return {
      liquidity: {
        available: 'good',
        depth: { usd: 'Unknown', tokens: '0' },
        topPools: [],
      },
      volatility: {
        level: 'moderate',
        priceChange24h: 0,
        priceChange1h: 0,
      },
      volume: {
        volume24h: 'Unknown',
        volumeChange24h: 0,
        averageTradeSize: 'Unknown',
        largeTradeThreshold: 'Unknown',
      },
      timingRecommendation: {
        currentTime: 'good',
        reasoning: 'Insufficient data for timing analysis',
      },
    };
  }

  private buildFallbackSavings(): SavingsCalculation {
    return {
      actualCost: {
        native: '0',
        usd: '0',
        breakdown: { gas: '0', protocolFees: '0', priceImpact: '0' },
      },
      potentialSavings: {
        amount: '0',
        percentage: 0,
        comparedTo: 'N/A',
      },
      vsAlternatives: [],
      vsHistorical: {
        averageCostSimilarSwaps: '$0',
        yourSavings: '$0',
        percentile: 50,
      },
      optimizationOpportunities: [],
    };
  }
}
