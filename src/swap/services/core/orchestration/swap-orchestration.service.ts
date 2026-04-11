import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { SwapRoutingService } from '../swap-routing.service';
import { AggregatorManagerService } from '../aggregation/aggregator-manager.service';
import { ApprovalService } from '@swap/services/blockchain/approval/approval.service';
import { QuoteService } from '../execution/quote.service';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import {
  AmountNormalizationUtils,
  ProviderAmountFormat,
} from '@shared/utils/amount-normalization.utils';
import { SwapExecutorFactory } from '../execution/executors/swap-executor-factory';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { TraceLoggerService, WorkflowStepStatus, LogLevel } from '@shared/services/trace-logger.service';
import { EnhancedResponseBuilderService } from '../execution/enhanced-response-builder.service';
import { SwapValidationService } from '../validation/swap-validation.service';
import { ExecutionStateService } from '../state/execution-state.service';
import { BridgeStatusTrackerService } from '../state/bridge-status-tracker.service';
import { GasReserveTrackerService } from '../gas-reserve-tracker.service';
import { DestinationFundDetectorService } from '../state/destination-fund-detector.service';
import { isNativeToken } from '@shared/utils/token-address.utils';
import { RoundTripOrchestrationService } from './round-trip-orchestration.service';
import type { IQueueService } from '@swap/services/queue/queue.interface';
import { WebhookService } from '@swap/services/webhook/webhook.service';
import {
  ExecutionStepStatus,
  ExecutionStep,
} from '@swap/dto/universal-response.dto';
import {
  UniversalSwapRequestDto,
  SwapType,
  BlockchainEcosystem,
} from '@swap/dto/universal-swap-request.dto';
import { CapabilityCheckRequestDto } from '@swap/dto/capability-check.dto';
import {
  UniversalResponse,
  CapabilityCheckData,
  ExecutionData,
  StatusData,
  ResponseMetadata,
} from '@swap/dto/universal-response.dto';
import {
  ExecutionRequest,
  ExecutionContext,
  ExecutionResult,
} from '../execution/ports/swap-executor.interface';
import { EnhancedExecutionData } from '@swap/dto/enhanced-execution-response.dto';
import { normalizeChainId } from '@shared/config/unified-token-configuration.config';
import { getChainName, getChainEcosystem } from '@shared/utils/chain.utils';
import { getAccountFromPrivateKey } from '@shared/utils/viem.utils';
import { normalizeTokenAddress } from '@shared/utils/ethereum.utils';
import { validateRecipientAddress } from '@shared/utils/validation.utils';

/**
 * Extended swap request that includes execution-specific properties
 * These properties are passed from the controller but are not part of the DTO
 */
interface ExtendedSwapRequest extends UniversalSwapRequestDto {
  userWallet?: string; // Alias for taker (backward compatibility)
  receiver?: string; // Alias for recipient (backward compatibility)
  privateKey?: string; // Required for server-side execution
  enhanced?: boolean; // Flag for enhanced response
}

/**
 * Swap Orchestration Service
 * Coordinates swap operations without HTTP concerns
 *
 * Responsibilities:
 * - Capability checks
 * - Quote retrieval
 * - Pre-checks (liquidity, approval, balance)
 * - Execution orchestration
 * - Route management
 */
@Injectable()
export class SwapOrchestrationService {
  private readonly logger: WinstonLoggerService;
  // Track expected destination balance changes for cross-chain swaps
  private readonly expectedDestinationMap: Map<
    string,
    {
      destChainId: number | string;
      recipient: string;
      tokenAddress?: string;
      preBalanceRaw: string;
      expectedMinOutRaw?: string;
      expectedEstOutRaw?: string;
    }
  > = new Map();

  constructor(
    private readonly swapRoutingService: SwapRoutingService,
    private readonly aggregatorManager: AggregatorManagerService,
    private readonly approvalService: ApprovalService,
    private readonly quoteService: QuoteService,
    private readonly walletService: WalletService,
    private readonly unifiedConfigService: UnifiedConfigurationService,
    private readonly amountUtils: AmountNormalizationUtils,
    private readonly executorFactory: SwapExecutorFactory,
    winstonLogger: WinstonLoggerService,
    private readonly traceLogger: TraceLoggerService,
    private readonly enhancedResponseBuilder: EnhancedResponseBuilderService,
    private readonly validationService: SwapValidationService,
    private readonly stateService: ExecutionStateService,
    private readonly bridgeTracker: BridgeStatusTrackerService,
    private readonly gasReserveTracker: GasReserveTrackerService,
    private readonly fundDetector: DestinationFundDetectorService,
    @Inject(forwardRef(() => RoundTripOrchestrationService))
    private readonly roundTripOrchestration: RoundTripOrchestrationService,
    @Optional()
    @Inject('IQueueService')
    private readonly queueService?: IQueueService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(SwapOrchestrationService.name);
  }

  /**
   * Check swap capabilities
   */
  async checkCapabilities(
    request: CapabilityCheckRequestDto,
  ): Promise<UniversalResponse<CapabilityCheckData>> {
    this.logger.log(
      `Capability check: ${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId} -> ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId}`,
    );

    try {
      // Validate request
      const validation =
        this.validationService.validateCapabilityRequest(request);
      if (!validation.isValid) {
        return {
          success: false,
          data: {} as CapabilityCheckData,
          metadata: this.createErrorMetadata(),
          error: validation.error,
        };
      }

      // Determine swap type and routing
      const swapType = this.swapRoutingService.determineSwapType({
        sellToken: request.sellToken,
        buyToken: request.buyToken,
        sellAmount: request.amount,
        taker: '0x0000000000000000000000000000000000000000',
        recipient: '0x0000000000000000000000000000000000000000',
      } as any);

      const providerCategory =
        this.swapRoutingService.determineProviderCategory(swapType, {
          sellToken: request.sellToken,
          buyToken: request.buyToken,
          sellAmount: request.amount,
          taker: '0x0000000000000000000000000000000000000000',
          recipient: '0x0000000000000000000000000000000000000000',
        } as any);

      const availableProviders =
        this.swapRoutingService.getProvidersForCategory(providerCategory, {
          sellToken: request.sellToken,
          buyToken: request.buyToken,
          sellAmount: request.amount,
          taker: '0x0000000000000000000000000000000000000000',
          recipient: '0x0000000000000000000000000000000000000000',
        } as any);

      const isCrossChain =
        request.sellToken.chain.chainId !== request.buyToken.chain.chainId;
      const crossChainSupported =
        isCrossChain &&
        providerCategory === 'meta' &&
        availableProviders.length > 0;

      const complexityEstimate = this.swapRoutingService.estimateSwapComplexity(
        {
          sellToken: request.sellToken,
          buyToken: request.buyToken,
          sellAmount: request.amount,
          taker: '0x0000000000000000000000000000000000000000',
          recipient: '0x0000000000000000000000000000000000000000',
        } as any,
      );

      // Determine recommended provider
      let recommendedProvider: string;
      let recommendedScore: number;
      let recommendedReason: string;

      if (availableProviders.length === 0) {
        recommendedProvider = 'none';
        recommendedScore = 0;
        recommendedReason = 'No providers available for this swap combination';
      } else if (availableProviders.length === 1) {
        recommendedProvider = availableProviders[0];
        recommendedScore = 90;
        recommendedReason = `Only provider available for this ${swapType} swap`;
      } else {
        recommendedProvider = 'auto';
        recommendedScore = 95;
        recommendedReason =
          'Auto-routing will select best provider based on real-time quotes';
      }

      // Get chain configurations
      const sourceChainConfig = this.unifiedConfigService.getChainConfiguration(
        request.sellToken.chain.chainId,
      );
      const destChainConfig = this.unifiedConfigService.getChainConfiguration(
        request.buyToken.chain.chainId,
      );
      const sellTokenDeployment =
        this.unifiedConfigService.getTokenConfiguration(
          request.sellToken.symbol,
        );
      const buyTokenDeployment =
        this.unifiedConfigService.getTokenConfiguration(
          request.buyToken.symbol,
        );
      const buyTokenOnChain =
        buyTokenDeployment?.chainDeployments?.[request.buyToken.chain.chainId];
      const buyTokenAvailable = buyTokenOnChain?.isEnabled === true;

      // Build response
      const data: CapabilityCheckData = {
        chainSupport: {
          sourceChainSupported: true,
          destinationChainSupported: true,
          crossChainSupported: isCrossChain ? crossChainSupported : false,
          sourceChain: {
            chainId: request.sellToken.chain.chainId,
            ecosystem: request.sellToken.chain.ecosystem,
            name:
              sourceChainConfig?.name ||
              request.sellToken.chain.name ||
              `Chain ${request.sellToken.chain.chainId}`,
            supported: true,
          },
          destinationChain: {
            chainId: request.buyToken.chain.chainId,
            ecosystem: request.buyToken.chain.ecosystem,
            name:
              destChainConfig?.name ||
              request.buyToken.chain.name ||
              `Chain ${request.buyToken.chain.chainId}`,
            supported: true,
          },
        },
        tokenSupport: {
          inputToken: {
            symbol: request.sellToken.symbol,
            supported: true,
            isApprovedInput: true,
            reason: `Token is approved and deployed on chain ${request.sellToken.chain.chainId}`,
          },
          outputToken: {
            symbol: request.buyToken.symbol,
            supported: buyTokenAvailable || !buyTokenDeployment,
            availableOnChain: buyTokenAvailable,
            reason: buyTokenAvailable
              ? `Token deployed and enabled on chain ${request.buyToken.chain.chainId}`
              : buyTokenDeployment
                ? `Token exists but not enabled on chain ${request.buyToken.chain.chainId}`
                : 'Output token will be resolved by aggregator providers',
          },
          liquidityStatus: {
            available: availableProviders.length > 0,
            providers: availableProviders,
          },
        },
        availableProviders,
        recommendedProvider: {
          provider: recommendedProvider,
          score: recommendedScore,
          reason: recommendedReason,
          alternatives: availableProviders
            .filter((p) => p !== recommendedProvider && p !== 'auto')
            .map((p) => ({
              provider: p,
              score: 85,
              reason: `Alternative ${swapType} provider`,
            })),
        },
      };

      const metadata: ResponseMetadata = {
        swapType,
        providerCategory,
        estimatedTime: complexityEstimate.estimatedTime,
        complexity: complexityEstimate.complexity,
        timestamp: new Date().toISOString(),
      };

      return {
        success: true,
        data,
        metadata,
      };
    } catch (error) {
      this.logger.error(
        `Capability check failed: ${error.message}`,
        error.stack,
      );

      return {
        success: false,
        data: {} as CapabilityCheckData,
        metadata: this.createErrorMetadata(),
        error: {
          code: 'CAPABILITY_CHECK_FAILED',
          message: error.message,
          details: error,
        },
      };
    }
  }

  /**
   * Get universal quote
   */
  async getUniversalQuote(request: UniversalSwapRequestDto): Promise<any> {
    this.logger.log(
      `Universal quote request: ${request.sellToken.symbol} on ${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId} -> ${request.buyToken.symbol} on ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId}`,
    );

    try {
      // Enrich token info
      const enrichedSellToken = this.unifiedConfigService.enrichTokenInfo(
        request.sellToken,
      );
      const enrichedBuyToken = this.unifiedConfigService.enrichTokenInfo(
        request.buyToken,
      );

      if (!enrichedSellToken) {
        throw new BadRequestException(
          `Sell token ${request.sellToken.symbol} is not configured or not available on chain ${request.sellToken.chain.chainId}`,
        );
      }

      if (!enrichedBuyToken) {
        throw new BadRequestException(
          `Buy token ${request.buyToken.symbol} is not configured or not available on chain ${request.buyToken.chain.chainId}`,
        );
      }

      request.sellToken.address = enrichedSellToken.address;
      request.sellToken.standard = enrichedSellToken.standard;
      request.sellToken.decimals = enrichedSellToken.decimals;
      request.buyToken.address = enrichedBuyToken.address;
      request.buyToken.standard = enrichedBuyToken.standard;
      request.buyToken.decimals = enrichedBuyToken.decimals;

      // Validate chain compatibility
      if (!this.swapRoutingService.validateChainCompatibility(request)) {
        throw new BadRequestException('Unsupported chain combination for swap');
      }

      // Validate taker address (source chain)
      if (request.taker) {
        this.validationService.validateTaker(
          request.sellToken.chain.ecosystem,
          request.sellToken.chain.chainId,
          request.taker,
        );
      }

      // Validate recipient if provided (destination chain)
      if (request.recipient) {
        this.validationService.validateRecipient(
          request.buyToken.chain.ecosystem,
          request.buyToken.chain.chainId,
          request.recipient,
        );
      }

      // Determine swap type and provider category
      const swapType = this.swapRoutingService.determineSwapType(request);
      const providerCategory =
        this.swapRoutingService.determineProviderCategory(swapType, request);
      const complexity =
        this.swapRoutingService.estimateSwapComplexity(request);
      const availableProviders =
        this.swapRoutingService.getProvidersForCategory(
          providerCategory,
          request,
        );

      // Route to provider manager
      const routes = await this.routeToProviderManager(
        providerCategory,
        request,
        swapType,
      );

      if (!routes || routes.length === 0) {
        throw new BadRequestException('No routes found for swap request');
      }

      return {
        routes,
        swapType,
        providerCategory,
        complexity,
        availableProviders,
      };
    } catch (error) {
      this.logger.error(
        `Universal quote failed: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to get universal quote: ${error.message}`,
      );
    }
  }

  /**
   * Route to provider manager based on category
   */
  private async routeToProviderManager(
    category: string,
    request: UniversalSwapRequestDto,
    swapType: SwapType,
  ): Promise<any[]> {
    switch (category) {
      case 'evm-aggregators':
        return await this.handleEvmAggregators(request);

      case 'meta':
        return await this.handleMetaAggregators(request);

      case 'solana':
        return await this.handleSolanaRouters(request);

      default:
        this.logger.warn(`Unknown provider category: ${category}`);
        return [
          {
            provider: 'unknown-category',
            outputAmount: '0',
            estimatedGas: '0',
            steps: [],
            estimatedTime: 60,
            qualityScore: 0,
            error: `Provider category '${category}' is not supported`,
          },
        ];
    }
  }

  /**
   * Handle EVM aggregator routing
   */
  private async handleEvmAggregators(
    request: UniversalSwapRequestDto,
  ): Promise<any[]> {
    // Implementation will be extracted from controller
    // For now, delegate to aggregator manager
    const legacyParams = this.convertToLegacyParams(request);
    const quotes = await this.aggregatorManager.getMultipleQuotes(
      legacyParams.chainId,
      legacyParams.sellToken,
      legacyParams.buyToken,
      legacyParams.sellAmount,
      legacyParams.taker,
      legacyParams.recipient,
      legacyParams.slippagePercentage,
      legacyParams.deadline,
    );

    return quotes.map((quote) => ({
      provider: quote.aggregator,
      outputAmount: quote.quote.buyAmount,
      estimatedGas: quote.quote.estimatedGas || '0',
      steps: [
        {
          kind: 'swap',
          chainId: legacyParams.chainId,
          details: {
            provider: quote.aggregator,
            fromToken: legacyParams.sellToken,
            toToken: legacyParams.buyToken,
          },
        },
      ],
      estimatedTime: 30,
      qualityScore: 100,
      providerRef: quote.quote,
    }));
  }

  /**
   * Handle meta aggregator routing
   * Respects user's preferredAggregator and preferredProvider parameters
   * Default preference order: Symbiosis > Rubic
   */
  private async handleMetaAggregators(
    request: UniversalSwapRequestDto,
  ): Promise<any[]> {
    const routeReq = {
      fromChainId: request.sellToken.chain.chainId as number,
      toChainId: request.buyToken.chain.chainId as number,
      fromToken: request.sellToken.address || 'ETH',
      toToken: request.buyToken.address || 'ETH',
      amount: request.sellAmount,
      slippageBps: request.slippageToleranceBps ?? 300,
      userAddress: request.taker,
      recipient: request.recipient,
      // Pass user preference to aggregator manager
      preferredAggregator:
        request.preferredAggregator || request.preferredProvider,
    };

    return await this.aggregatorManager.getCrossChainRoutes(routeReq);
  }

  /**
   * Handle Solana router routing
   */
  private async handleSolanaRouters(
    request: UniversalSwapRequestDto,
  ): Promise<any[]> {
    if (
      request.sellToken.chain.ecosystem !== BlockchainEcosystem.SOLANA ||
      request.buyToken.chain.ecosystem !== BlockchainEcosystem.SOLANA
    ) {
      throw new Error(
        `Solana routers can only handle Solana ecosystem swaps. ` +
          `Got: ${request.sellToken.chain.ecosystem} -> ${request.buyToken.chain.ecosystem}`,
      );
    }

    const sellChainId = String(request.sellToken.chain.chainId);
    const buyChainId = String(request.buyToken.chain.chainId);

    if (sellChainId !== buyChainId) {
      this.logger.warn(
        `Cross-chain Solana swap detected (${sellChainId} -> ${buyChainId}), ` +
          `routing to meta aggregators instead`,
      );
      return await this.handleMetaAggregators(request);
    }

    if (!request.sellToken.address || !request.buyToken.address) {
      throw new Error('Token addresses (mints) are required for Solana swaps');
    }

    const solanaQuoteRequest = {
      fromMint: request.sellToken.address,
      toMint: request.buyToken.address,
      amount: request.sellAmount,
      slippageBps: request.slippageToleranceBps ?? 300,
      userPublicKey: request.taker,
      fromChainId: sellChainId,
      toChainId: buyChainId,
      platformFeeBps: 0,
    };

    const quote = await this.aggregatorManager.getSolanaQuote(
      solanaQuoteRequest,
      request.preferredProvider,
    );

    if (!quote || !quote.totalEstimatedOut || quote.totalEstimatedOut === '0') {
      throw new Error('Invalid Solana quote received');
    }

    return [
      {
        provider: request.preferredProvider || 'rubic',
        outputAmount: quote.totalEstimatedOut,
        estimatedGas: quote.fees?.gas || '5000',
        steps: this.buildSolanaRouteSteps(quote, request),
        estimatedTime: quote.etaSeconds || 30,
        qualityScore: this.calculateSolanaQualityScore(
          quote,
          request.preferredProvider || 'rubic',
        ),
        routeId: quote.routeId,
        providerRef: quote.providerRef || quote,
        metadata: {
          provider: request.preferredProvider || 'rubic',
          priceImpact: quote.priceImpact,
          fees: quote.fees,
          confidence: quote.confidence,
          computeUnits: quote.providerRef?.computeUnits,
          priorityFee: quote.providerRef?.priorityFee,
          slippageBps: solanaQuoteRequest.slippageBps,
          originalQuote: quote,
        },
      },
    ];
  }

  /**
   * Build Solana route steps
   */
  private buildSolanaRouteSteps(
    quote: any,
    request: UniversalSwapRequestDto,
  ): any[] {
    const steps = quote.steps || [];

    if (steps.length === 0) {
      return [
        {
          action: 'swap' as const,
          provider: quote.providerRef?.protocol || 'solana-dex',
          fromToken: request.sellToken.address!,
          toToken: request.buyToken.address!,
          fromChain: String(request.sellToken.chain.chainId),
          toChain: String(request.buyToken.chain.chainId),
          estimatedTime: quote.etaSeconds || 30,
          dex: quote.providerRef?.dex,
          marketId: quote.providerRef?.marketId,
        },
      ];
    }

    return steps.map((step: any, index: number) => ({
      action: step.kind || ('swap' as const),
      provider: step.protocol || 'solana-dex',
      fromToken:
        index === 0
          ? request.sellToken.address!
          : steps[index - 1].outputMint || step.inputMint,
      toToken:
        index === steps.length - 1
          ? request.buyToken.address!
          : step.outputMint,
      fromChain: String(request.sellToken.chain.chainId),
      toChain: String(request.buyToken.chain.chainId),
      estimatedTime:
        step.estimatedTime || (quote.etaSeconds || 30) / steps.length,
      dex: step.dex,
      marketId: step.marketId,
      fee: step.fee,
    }));
  }

  /**
   * Calculate Solana quality score
   */
  private calculateSolanaQualityScore(quote: any, provider: string): number {
    let score = 100;

    if (provider.toLowerCase() === 'rubic') {
      score += 10;
    } else if (provider.toLowerCase() === 'jupiter') {
      score += 8;
    }

    if (quote.priceImpact) {
      const priceImpact = parseFloat(quote.priceImpact);
      if (priceImpact < 0.5) {
        score += 5;
      } else if (priceImpact > 2) {
        score -= 15;
      } else if (priceImpact > 5) {
        score -= 30;
      }
    }

    if (quote.confidence) {
      const confidenceBonus = Math.round((quote.confidence - 0.5) * 20);
      score += confidenceBonus;
    }

    const steps = quote.steps?.length || 1;
    if (steps === 1) {
      score += 5;
    } else if (steps > 3) {
      score -= (steps - 3) * 5;
    }

    const etaSeconds = quote.etaSeconds || 30;
    if (etaSeconds < 20) {
      score += 3;
    } else if (etaSeconds > 60) {
      score -= 5;
    }

    if (quote.fees?.gas) {
      const gasLamports = parseFloat(quote.fees.gas);
      if (gasLamports < 3000) {
        score += 3;
      } else if (gasLamports > 10000) {
        score -= 5;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Convert universal request to legacy params
   */
  private convertToLegacyParams(request: ExtendedSwapRequest): any {
    return {
      chainId: request.sellToken.chain.chainId,
      sellToken: request.sellToken.address!,
      buyToken: request.buyToken.address!,
      sellAmount: request.sellAmount,
      taker: request.taker || request.userWallet,
      recipient:
        request.recipient ||
        request.receiver ||
        request.taker ||
        request.userWallet,
      slippagePercentage: request.slippageToleranceBps
        ? request.slippageToleranceBps / 100
        : 0.5,
      deadline: undefined,
    };
  }

  /**
   * Execute swap request
   */
  async executeSwap(
    request: ExtendedSwapRequest,
    executionId: string,
    startTime: number,
    traceId?: string,
  ): Promise<
    UniversalResponse<ExecutionData> | UniversalResponse<EnhancedExecutionData>
  > {
    // Use provided traceId or generate new one (for backward compatibility)
    const currentTraceId = traceId || this.traceLogger.generateTraceId();
    
    // Log execution start
    const rootLogId = this.traceLogger.log(
      currentTraceId,
      undefined,
      LogLevel.INFO,
      'SwapOrchestrationService',
      `Starting swap execution: ${executionId}`,
      {
        executionId,
        sellToken: request.sellToken.symbol,
        buyToken: request.buyToken.symbol,
        sellAmount: request.sellAmount,
      },
    );

    // Check if async execution is requested
    if (request.async) {
      // Validate queue service is available
      if (!this.queueService) {
        this.traceLogger.updateStepStatus(
          currentTraceId,
          0,
          WorkflowStepStatus.FAILED,
          { error: 'Queue service not enabled' },
        );
        throw new BadRequestException(
          'Async execution requested but queue service is not enabled. ' +
            'Please set QUEUE_ENABLED=true in environment configuration.',
        );
      }

      // Validate webhook URL if provided
      if (
        request.webhookUrl &&
        !WebhookService.isValidWebhookUrl(request.webhookUrl)
      ) {
        this.traceLogger.updateStepStatus(
          currentTraceId,
          0,
          WorkflowStepStatus.FAILED,
          { error: 'Invalid webhook URL' },
        );
        throw new BadRequestException(
          `Invalid webhook URL: ${request.webhookUrl}. ` +
            'URL must use http:// or https:// protocol.',
        );
      }

      this.logger.log(
        `📋 Async execution requested, adding job to queue: ${executionId}`,
      );
      
      this.traceLogger.log(
        currentTraceId,
        rootLogId,
        LogLevel.INFO,
        'SwapOrchestrationService',
        'Adding job to queue for async processing',
        { executionId },
      );

      const jobId = await this.queueService.addSwapJob({
        executionId,
        request,
        userWallet: request.taker || request.userWallet!,
        timestamp: Date.now(),
        priority: (request as any).priority,
        webhookUrl: request.webhookUrl,
      });

      this.logger.log(`✅ Job queued successfully: ${jobId}`);
      
      this.traceLogger.log(
        currentTraceId,
        rootLogId,
        LogLevel.INFO,
        'SwapOrchestrationService',
        `Job queued successfully: ${jobId}`,
        { jobId, executionId },
      );

      const queuedStatus: ExecutionStepStatus = {
        overall: 'PENDING',
        currentStep: 0,
        totalSteps: 1,
        progressPercentage: 0,
      };

      const queuedStep: ExecutionStep = {
        step: 1,
        action: 'Swap job queued for async execution',
        status: 'PENDING',
        chainId: request.sellToken.chain.chainId,
        provider: 'queue',
        estimatedTime: 30,
      };

      return {
        success: true,
        data: {
          executionId,
          jobId,
          transactionHashes: [],
          status: queuedStatus,
          steps: [queuedStep],
          estimatedCompletion: new Date(Date.now() + 30000).toISOString(),
          trackingUrls: [],
        } as ExecutionData,
        metadata: this.createErrorMetadata(),
      };
    }

    // Detect round-trip swap and delegate to RoundTripOrchestrationService
    if (request.finalOutputToken) {
      this.logger.log(
        `🔄 Round-trip swap detected: ${request.sellToken.symbol} → ${request.buyToken.symbol} → ${request.finalOutputToken.symbol}`,
      );
      this.traceLogger.log(
        currentTraceId,
        rootLogId,
        LogLevel.INFO,
        'SwapOrchestrationService',
        'Round-trip swap detected, delegating to round-trip orchestration',
        {
          executionId,
          sellToken: request.sellToken.symbol,
          buyToken: request.buyToken.symbol,
          finalOutputToken: request.finalOutputToken.symbol,
        },
      );
      return this.roundTripOrchestration.executeRoundTripSwap(request);
    }

    // Step 0: Request Validation
    this.traceLogger.updateStepStatus(
      currentTraceId,
      0,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const validationLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Validating swap request',
      { executionId },
    );

    // Validate swap request
    this.validationService.validateSwapRequest(request);

    // Normalize wallet addresses
    const normalizedRequest = this.normalizeWalletAddresses(request);

    this.traceLogger.logChild(
      currentTraceId,
      validationLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Request validation successful',
      { executionId },
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      0,
      WorkflowStepStatus.COMPLETED,
    );

    // Step 1: Token Enrichment
    this.traceLogger.updateStepStatus(
      currentTraceId,
      1,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const enrichmentLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Enriching token information',
      { executionId },
    );

    // Enrich token information
    this.enrichTokenInformation(normalizedRequest);

    // Validate chain compatibility
    if (
      !this.swapRoutingService.validateChainCompatibility(normalizedRequest)
    ) {
      this.traceLogger.updateStepStatus(
        currentTraceId,
        1,
        WorkflowStepStatus.FAILED,
        { error: 'Unsupported chain combination' },
      );
      throw new BadRequestException('Unsupported chain combination for swap');
    }

    // Validate recipient if provided
    if (normalizedRequest.recipient) {
      this.validationService.validateRecipient(
        normalizedRequest.buyToken.chain.ecosystem,
        normalizedRequest.buyToken.chain.chainId,
        normalizedRequest.recipient,
      );
    }

    this.traceLogger.logChild(
      currentTraceId,
      enrichmentLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Token enrichment completed',
      {
        executionId,
        sellToken: normalizedRequest.sellToken,
        buyToken: normalizedRequest.buyToken,
      },
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      1,
      WorkflowStepStatus.COMPLETED,
    );

    // Track full balance swaps for gas cost recording (actual adjustment happens in executor)
    let fullBalanceTracking:
      | {
          ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin';
          transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap';
          originalBalance: bigint;
          gasReserve: bigint;
          chainId: string | number;
        }
      | undefined;

    // Note: swapFullBalance adjustment is now handled entirely in the executor's preExecute()
    // This ensures accurate gas estimation with access to the actual route/quote data
    // Orchestration only tracks metadata for post-execution gas cost recording

    // Step 2: Route Selection
    this.traceLogger.updateStepStatus(
      currentTraceId,
      2,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const routeLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Determining swap type and selecting route',
      { executionId },
    );

    // Determine swap type and provider category
    const swapType =
      this.swapRoutingService.determineSwapType(normalizedRequest);
    const providerCategory = this.swapRoutingService.determineProviderCategory(
      swapType,
      normalizedRequest,
    );

    this.traceLogger.logChild(
      currentTraceId,
      routeLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      `Swap type determined: ${swapType}, provider category: ${providerCategory}`,
      { executionId, swapType, providerCategory },
    );

    // Step 3: Quote Retrieval
    this.traceLogger.updateStepStatus(
      currentTraceId,
      2,
      WorkflowStepStatus.COMPLETED,
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      3,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const quoteLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Fetching routes from providers',
      { executionId, providerCategory },
    );

    // Track quote fetch timing for expiry debugging
    const quoteFetchStartTime = Date.now();
    
    // Fetch routes
    const routes = await this.routeToProviderManager(
      providerCategory,
      normalizedRequest,
      swapType,
    );

    const quoteFetchDuration = Date.now() - quoteFetchStartTime;
    this.logger.debug('Quote fetch completed', {
      executionId,
      durationMs: quoteFetchDuration,
      routeCount: routes?.length || 0,
    });

    if (!routes || routes.length === 0 || !routes[0]) {
      this.traceLogger.updateStepStatus(
        currentTraceId,
        3,
        WorkflowStepStatus.FAILED,
        { error: 'No executable routes found' },
      );
      throw new BadRequestException('No executable routes found for request');
    }

    let selectedRoute = routes[0];

    this.traceLogger.logChild(
      currentTraceId,
      quoteLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      `Route selected: ${selectedRoute.provider}, estimated output: ${selectedRoute.outputAmount}`,
      {
        executionId,
        provider: selectedRoute.provider,
        outputAmount: selectedRoute.outputAmount,
        routeId: selectedRoute.routeId,
      },
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      3,
      WorkflowStepStatus.COMPLETED,
      { provider: selectedRoute.provider },
    );

    // Validate and prepare route
    this.prepareRoute(selectedRoute, normalizedRequest);

    // Select executor
    let executor = this.executorFactory.getExecutor(selectedRoute);

    // Validate privateKey is present (required for execution)
    if (!normalizedRequest.privateKey) {
      throw new BadRequestException(
        'Private key is required for server-side execution',
      );
    }

    // Validate userWallet/taker is present
    const userWallet = normalizedRequest.taker || normalizedRequest.userWallet;
    if (!userWallet) {
      throw new BadRequestException(
        'User wallet address (taker) is required for execution',
      );
    }

    // Build execution context
    // Debug log: Track swapFullBalance flag in orchestration
    this.logger.debug('🔍 Orchestration: swapFullBalance flag', {
      rawValue: normalizedRequest.swapFullBalance,
      type: typeof normalizedRequest.swapFullBalance,
      normalizedValue: normalizedRequest.swapFullBalance || false,
    });

    const executionRequest: ExecutionRequest = {
      routeId: selectedRoute.routeId,
      route: selectedRoute,
      userWallet,
      recipient:
        normalizedRequest.recipient || normalizedRequest.receiver || userWallet,
      privateKey: normalizedRequest.privateKey,
      slippageToleranceBps: normalizedRequest.slippageToleranceBps || 50,
      swapFullBalance: normalizedRequest.swapFullBalance || false,
    };

    const executionContext: ExecutionContext = {
      request: executionRequest,
      validations: {
        routeValid: true,
        slippageAcceptable: true,
        providerHealthy: true,
      },
      executionStartTime: new Date(),
    };

    // Pre-execution: for cross-chain routes, record destination pre-balance and expected outputs
    try {
      const firstStep = selectedRoute?.steps?.[0];
      const lastStep = selectedRoute?.steps?.[selectedRoute.steps.length - 1];
      const isCrossChainPre =
        !!firstStep && !!lastStep && firstStep.chainId !== lastStep.chainId;
      if (isCrossChainPre) {
        const destChainId = lastStep.chainId;
        // Ensure recipient address is defined (fallback to userWallet)
        const recipientAddr =
          executionRequest.recipient || executionRequest.userWallet;
        // Try to infer destination token address from step details or providerRef
        const toTokenAddr =
          lastStep.details?.toToken || normalizedRequest.buyToken.address;

        // Expected outputs from route metadata/providerRef if present
        const expectedMinOutRaw =
          selectedRoute.minimumOutputAmount?.raw ||
          selectedRoute.metadata?.minimumOutputAmount?.raw;
        const expectedEstOutRaw =
          selectedRoute.estimatedOutputAmount?.raw ||
          selectedRoute.metadata?.estimatedOutputAmount?.raw;

        // Fetch destination pre-balance (native if toTokenAddr undefined)
        const preBal = await this.walletService.getBalance(
          destChainId,
          recipientAddr,
          toTokenAddr,
          this.detectEcosystemFromChainId(destChainId),
        );

        this.expectedDestinationMap.set(executionId, {
          destChainId,
          recipient: recipientAddr,
          tokenAddress: toTokenAddr,
          preBalanceRaw: preBal.balance,
          expectedMinOutRaw,
          expectedEstOutRaw,
        });

        this.logger.log(
          '📌 Recorded destination pre-balance and expected outputs',
          {
            executionId,
            destChainId,
            recipient: recipientAddr,
            tokenAddress: toTokenAddr,
            preBalance: preBal.balance,
            expectedMinOutRaw,
            expectedEstOutRaw,
          },
        );
      }
    } catch (preTrackErr) {
      this.logger.warn(
        `Failed pre-track destination balance: ${preTrackErr.message}`,
      );
    }

    // Validate executor
    // Step 4: Approval Check (skip if no approval needed)
    const validationStartTime = Date.now();
    const timeSinceQuoteFetch = validationStartTime - quoteFetchStartTime;
    
    this.logger.debug('Starting executor validation', {
      executionId,
      timeSinceQuoteFetchMs: timeSinceQuoteFetch,
      quoteFetchDurationMs: quoteFetchDuration,
    });
    
    this.traceLogger.updateStepStatus(
      currentTraceId,
      4,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const approvalLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Validating executor and checking approvals',
      { executionId },
    );

    this.logger.log('🔍 ORCHESTRATION: About to call executor.validate()');
    let validationErrors = await executor.validate(executionContext);
    this.logger.log('🔍 ORCHESTRATION: validator.validate() returned', {
      errorCount: validationErrors.length,
      errors: validationErrors,
    });
    
    // Check if validation failed due to quote expiry
    const hasQuoteExpiredError = validationErrors.some(
      (error) =>
        typeof error === 'string' &&
        (error.includes('Quote expired') || error.includes('quote expired')),
    );

    // If quote expired, refetch and retry validation once
    // Only refetch if orchestration took significant time (> 3s) to avoid refetching immediately
    // This prevents infinite loops while still catching legitimate orchestration delays
    if (hasQuoteExpiredError && timeSinceQuoteFetch > 3000) {
      this.logger.warn(
        '⚠️ Quote expired during orchestration, refetching quote and retrying...',
        {
          executionId,
          timeSinceQuoteFetchMs: timeSinceQuoteFetch,
          originalErrors: validationErrors,
        },
      );

      this.traceLogger.logChild(
        currentTraceId,
        approvalLogId,
        LogLevel.WARN,
        'SwapOrchestrationService',
        'Quote expired, refetching for retry',
        {
          executionId,
          timeSinceQuoteFetch,
          reason: 'Orchestration overhead caused quote expiry',
        },
      );

      try {
        // Refetch routes with fresh quotes
        const refetchStartTime = Date.now();
        const freshRoutes = await this.routeToProviderManager(
          providerCategory,
          normalizedRequest,
          swapType,
        );

        if (!freshRoutes || freshRoutes.length === 0 || !freshRoutes[0]) {
          throw new BadRequestException(
            'No routes available after quote refresh',
          );
        }

        const freshRoute = freshRoutes[0];
        const refetchDuration = Date.now() - refetchStartTime;

        this.logger.log('✅ Quote refetched successfully', {
          executionId,
          refetchDurationMs: refetchDuration,
          newQuoteAge: freshRoute.quotedAt
            ? Date.now() - freshRoute.quotedAt
            : 'unknown',
        });

        // Prepare fresh route
        this.prepareRoute(freshRoute, normalizedRequest);

        // Recreate executor with fresh route
        const freshExecutor = this.executorFactory.getExecutor(freshRoute);

        // Update execution context with fresh route
        executionContext.request.route = freshRoute;

        // Retry validation with fresh quote
        validationErrors = await freshExecutor.validate(executionContext);

        this.logger.log('🔍 ORCHESTRATION: Retry validation returned', {
          errorCount: validationErrors.length,
          errors: validationErrors,
        });

        // If still failing, throw original error
        if (validationErrors.length > 0) {
          this.logger.error(
            '❌ Validation still failing after quote refetch',
            {
              executionId,
              errors: validationErrors,
            },
          );
          this.traceLogger.updateStepStatus(
            currentTraceId,
            4,
            WorkflowStepStatus.FAILED,
            { errors: validationErrors, retriedAfterExpiry: true },
          );
          throw new BadRequestException(
            `Validation failed after quote refresh: ${validationErrors.join(', ')}`,
          );
        }

        // Success! Update executor and route for execution
        executor = freshExecutor;
        selectedRoute = freshRoute;

        this.traceLogger.logChild(
          currentTraceId,
          approvalLogId,
          LogLevel.INFO,
          'SwapOrchestrationService',
          'Quote refetch successful, validation passed',
          {
            executionId,
            refetchDurationMs: refetchDuration,
          },
        );
      } catch (refetchError) {
        this.logger.error(
          '❌ Quote refetch failed',
          {
            executionId,
            error: refetchError.message,
            originalErrors: validationErrors,
          },
        );
        this.traceLogger.updateStepStatus(
          currentTraceId,
          4,
          WorkflowStepStatus.FAILED,
          { errors: validationErrors, refetchFailed: true },
        );
        throw new BadRequestException(
          `Validation failed: ${validationErrors.join(', ')} (quote refetch also failed: ${refetchError.message})`,
        );
      }
    } else if (validationErrors.length > 0) {
      // Non-expiry validation errors or quote is too fresh to refetch
      this.traceLogger.updateStepStatus(
        currentTraceId,
        4,
        WorkflowStepStatus.FAILED,
        { errors: validationErrors },
      );
      throw new BadRequestException(
        `Validation failed: ${validationErrors.join(', ')}`,
      );
    }

    this.traceLogger.logChild(
      currentTraceId,
      approvalLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Executor validation passed',
      { executionId },
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      4,
      WorkflowStepStatus.COMPLETED,
    );

    // Step 5: Transaction Preparation
    this.traceLogger.updateStepStatus(
      currentTraceId,
      5,
      WorkflowStepStatus.IN_PROGRESS,
    );
    this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Preparing transaction for execution',
      { executionId },
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      5,
      WorkflowStepStatus.COMPLETED,
    );

    // Step 6: Transaction Execution
    this.traceLogger.updateStepStatus(
      currentTraceId,
      6,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const executionLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Executing swap transaction',
      { executionId },
    );

    // Execute swap
    this.logger.log('🔍 ORCHESTRATION: About to call executor.execute()');
    const executionResult = await this.traceLogger.logTimed(
      currentTraceId,
      executionLogId,
      'SwapOrchestrationService',
      'Transaction execution',
      async () => executor.execute(executionContext),
      { executionId },
    );

    if (executionResult.result.success) {
      this.traceLogger.logChild(
        currentTraceId,
        executionLogId,
        LogLevel.INFO,
        'SwapOrchestrationService',
        `Transaction executed successfully: ${executionResult.result.transactionHash}`,
        {
          executionId,
          transactionHash: executionResult.result.transactionHash,
          duration: executionResult.duration,
        },
      );
      this.traceLogger.updateStepStatus(
        currentTraceId,
        6,
        WorkflowStepStatus.COMPLETED,
        { transactionHash: executionResult.result.transactionHash },
      );
    } else {
      this.traceLogger.logChild(
        currentTraceId,
        executionLogId,
        LogLevel.ERROR,
        'SwapOrchestrationService',
        `Transaction execution failed: ${executionResult.result.error}`,
        {
          executionId,
          error: executionResult.result.error,
          duration: executionResult.duration,
        },
      );
      this.traceLogger.updateStepStatus(
        currentTraceId,
        6,
        WorkflowStepStatus.FAILED,
        { error: executionResult.result.error },
      );
    }

    const actualExecutionResult = executionResult.result;

    // Record transaction cost for adaptive learning (if full balance swap)
    if (fullBalanceTracking && actualExecutionResult.transactionHash) {
      try {
        // Calculate actual gas cost from execution result
        let actualCost: bigint = BigInt(0);
        if (actualExecutionResult.gasUsed && actualExecutionResult.effectiveGasPrice) {
          actualCost =
            BigInt(actualExecutionResult.gasUsed) *
            BigInt(actualExecutionResult.effectiveGasPrice);
        }

        // Record cost data for future adaptive calculations
        this.gasReserveTracker.recordTransactionCost({
          ecosystem: fullBalanceTracking.ecosystem,
          transactionType: fullBalanceTracking.transactionType,
          actualCost: actualCost.toString(),
          balance: fullBalanceTracking.originalBalance.toString(),
          success: actualExecutionResult.success,
          reserveUsed: fullBalanceTracking.gasReserve.toString(),
          chainId: fullBalanceTracking.chainId,
          errorMessage: actualExecutionResult.error,
        });

        this.logger.log('📊 Recorded transaction cost for adaptive learning', {
          executionId,
          ecosystem: fullBalanceTracking.ecosystem,
          transactionType: fullBalanceTracking.transactionType,
          actualCost: actualCost.toString(),
          reserveUsed: fullBalanceTracking.gasReserve.toString(),
          success: actualExecutionResult.success,
        });
      } catch (recordError) {
        // Don't fail the swap if recording fails
        this.logger.warn(
          `Failed to record transaction cost: ${recordError.message}`,
        );
      }
    }

    // Step 7: Confirmation Tracking (for cross-chain swaps)
    this.traceLogger.updateStepStatus(
      currentTraceId,
      7,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const trackingLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Building tracking URLs and monitoring confirmations',
      { executionId },
    );

    // Build tracking URLs
    const trackingUrls = this.buildTrackingUrls(actualExecutionResult);

    this.traceLogger.logChild(
      currentTraceId,
      trackingLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      `Tracking URLs generated: ${trackingUrls.length} URLs`,
      { executionId, trackingUrlsCount: trackingUrls.length },
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      7,
      WorkflowStepStatus.COMPLETED,
    );

    // Step 8: Result Processing
    this.traceLogger.updateStepStatus(
      currentTraceId,
      8,
      WorkflowStepStatus.IN_PROGRESS,
    );
    const resultLogId = this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Building final execution response',
      { executionId },
    );

    // Build execution response
    const executionData = await this.buildExecutionResponse(
      executionId,
      actualExecutionResult,
      executionContext,
      selectedRoute,
      executor,
      trackingUrls,
      startTime,
      request.enhanced,
    );

    // Save execution snapshot
    this.stateService.saveExecutionSnapshot(
      executionId,
      selectedRoute,
      actualExecutionResult,
    );

    // If cross-chain, start background bridge tracking (Rubic currently supported)
    try {
      const isCrossChain =
        selectedRoute?.steps?.[0]?.chainId !==
        selectedRoute?.steps?.[selectedRoute.steps.length - 1]?.chainId;
      if (isCrossChain && actualExecutionResult.transactionHash) {
        this.bridgeTracker.startTracking(
          executionId,
          selectedRoute,
          actualExecutionResult.transactionHash,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Failed to start bridge status tracking: ${(e as Error).message}`,
      );
    }

    // Build metadata
    const metadata: ResponseMetadata = {
      swapType: this.determineSwapTypeFromRoute(selectedRoute),
      providerCategory: 'auto',
      estimatedTime: selectedRoute.etaSeconds || 30,
      complexity: (selectedRoute.steps?.length || 0) > 1 ? 'complex' : 'simple',
      timestamp: new Date().toISOString(),
      executionId,
    };

    this.traceLogger.logChild(
      currentTraceId,
      resultLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      'Execution response built successfully',
      {
        executionId,
        success: actualExecutionResult.success,
        duration: Date.now() - startTime,
      },
    );
    this.traceLogger.updateStepStatus(
      currentTraceId,
      8,
      WorkflowStepStatus.COMPLETED,
    );

    // Final log
    this.traceLogger.log(
      currentTraceId,
      rootLogId,
      LogLevel.INFO,
      'SwapOrchestrationService',
      `Swap execution completed: ${actualExecutionResult.success ? 'SUCCESS' : 'FAILED'}`,
      {
        executionId,
        success: actualExecutionResult.success,
        transactionHash: actualExecutionResult.transactionHash,
        totalDuration: Date.now() - startTime,
      },
    );

    return {
      success: actualExecutionResult.success,
      data: executionData as any,
      metadata,
      warnings: actualExecutionResult.warnings || [],
      error: actualExecutionResult.error
        ? {
            code: 'EXECUTION_FAILED',
            message: actualExecutionResult.error,
            details: actualExecutionResult.errorDetails,
          }
        : undefined,
    } as
      | UniversalResponse<ExecutionData>
      | UniversalResponse<EnhancedExecutionData>;
  }

  /**
   * Get execution status
   */
  async getExecutionStatus(
    executionId: string,
  ): Promise<UniversalResponse<StatusData>> {
    const snapshot = await this.stateService.getExecutionSnapshot(executionId);

    if (!snapshot) {
      const statusData: StatusData = {
        executionId,
        status: {
          overall: 'PENDING',
          currentStep: 0,
          totalSteps: 1,
          progressPercentage: 0,
        },
        steps: [],
        transactions: [],
      };

      const metadata: ResponseMetadata = {
        swapType: SwapType.ON_CHAIN,
        providerCategory: 'auto',
        estimatedTime: 0,
        complexity: 'simple',
        timestamp: new Date().toISOString(),
        executionId,
      };

      return { success: true, data: statusData, metadata };
    }

    const isCrossChain = snapshot.swapType === SwapType.CROSS_CHAIN;
    const totalSteps = isCrossChain ? 2 : 1;

    const step1Success = !!snapshot.source.txHash;
    const step1Status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' =
      step1Success ? 'SUCCESS' : 'PENDING';

    let step2Status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' =
      'PENDING';
    if (isCrossChain) {
      if (snapshot.bridge?.destTxHash) step2Status = 'SUCCESS';
      else if (step1Success) step2Status = 'IN_PROGRESS';
    }

    let overall: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'REVERTED' =
      'PENDING';
    if (!isCrossChain) overall = step1Status;
    else overall = step2Status === 'SUCCESS' ? 'SUCCESS' : step2Status;

    let progress = 0;
    if (!isCrossChain) {
      progress = step1Success ? 100 : 0;
    } else {
      if (step1Success) {
        // Use bridge progress percentage if available
        if (snapshot.bridge?.progressPercentage !== undefined) {
          progress = Math.round(
            50 + (snapshot.bridge.progressPercentage / 100) * 50,
          );
        } else {
          const startedAt = snapshot.bridge?.startedAt || snapshot.updatedAt;
          const eta = snapshot.bridge?.etaMs || 30 * 60 * 1000;
          const elapsed = Date.now() - startedAt;
          const bridgePct = Math.min(0.99, Math.max(0, elapsed / eta));
          progress =
            step2Status === 'SUCCESS' ? 100 : Math.round(50 + bridgePct * 50);
        }
      } else {
        progress = 25;
      }
    }

    const steps: any[] = [];
    steps.push({
      step: 1,
      action: 'Source chain transaction',
      status: step1Status,
      chainId: snapshot.source.chainId,
      provider: 'auto',
      estimatedTime: 30,
      txHash: snapshot.source.txHash,
    } as any);
    if (isCrossChain) {
      const step2: any = {
        step: 2,
        action: 'Bridge to destination chain',
        status: step2Status,
        chainId: snapshot.bridge?.destChainId || snapshot.source.chainId,
        provider: 'meta',
        estimatedTime: Math.round(
          (snapshot.bridge?.etaMs || 30 * 60 * 1000) / 1000,
        ),
        txHash: snapshot.bridge?.destTxHash,
        // Add bridge-specific details
        bridgeStatus: snapshot.bridge?.status,
        lastChecked: snapshot.bridge?.lastCheckedAt
          ? new Date(snapshot.bridge.lastCheckedAt).toISOString()
          : undefined,
        checkCount: snapshot.bridge?.checkCount,
        errorCount: snapshot.bridge?.errorCount,
        lastError: snapshot.bridge?.lastError,
      } as any;

      // Balance-based progress probing when provider status is not yet finalized
      // Use multi-layered detection with retry resilience
      try {
        const expected = this.expectedDestinationMap.get(executionId);
        if (expected) {
          // Detect ecosystem from chain ID
          const ecosystem = this.detectEcosystemFromChainId(
            expected.destChainId,
          );

          // Probe balance with retry logic (3 attempts with exponential backoff)
          const probeResult = await this.fundDetector.probeBalanceWithRetry(
            executionId,
            expected.destChainId,
            expected.recipient,
            expected.tokenAddress,
            ecosystem,
            expected.preBalanceRaw,
            expected.expectedMinOutRaw,
            expected.expectedEstOutRaw,
            {
              maxAttempts: 3,
              baseDelayMs: 2000,
              maxDelayMs: 10000,
              backoffMultiplier: 2.5,
            },
          );

          // Add probe results to step2
          if (probeResult.success) {
            step2.balanceProbe = {
              preBalance: expected.preBalanceRaw,
              currentBalance: probeResult.currentBalance,
              delta: probeResult.delta,
              expectedMinOut: expected.expectedMinOutRaw,
              expectedEstOut: expected.expectedEstOutRaw,
              meetsExpectation: probeResult.meetsExpectation,
              confidence: probeResult.confidence,
              retriesAttempted: probeResult.attempt,
            };

            // If meets expectation with sufficient confidence and destTxHash missing, mark success
            if (
              !snapshot.bridge?.destTxHash &&
              probeResult.meetsExpectation &&
              probeResult.confidence !== 'low'
            ) {
              // Persist balance-confirmed success in snapshot
              this.stateService.markDestinationBalanceConfirmed(executionId, {
                deltaRaw: probeResult.delta,
                expectedMinOutRaw: expected.expectedMinOutRaw,
                expectedEstOutRaw: expected.expectedEstOutRaw,
              });
              // Reflect immediate success in response objects
              step2.status = 'SUCCESS';
              overall = 'SUCCESS';
              progress = 100;

              // Auto-chain round-trip second leg if enabled and waiting
              try {
                const snapRt = (
                  await this.stateService.getExecutionSnapshot(executionId)
                )?.roundTrip;
                if (
                  snapRt?.enabled &&
                  (snapRt.leg2?.status === 'WAITING' || !snapRt.leg2)
                ) {
                  await this.roundTripOrchestration.startSecondLegFromSnapshot(
                    executionId,
                  );
                }
              } catch (autoErr) {
                this.logger.warn(
                  `Auto-chain trigger failed: ${(autoErr as Error).message}`,
                );
              }
            }
          } else {
            // Probe failed after all retries
            step2.balanceProbeError = probeResult.error;
            this.logger.warn(
              `Balance probe failed after ${probeResult.attempt || 0} attempts: ${probeResult.error}`,
            );
          }
        }
      } catch (probeErr) {
        // Non-fatal probing error
        step2.balanceProbeError = probeErr.message;
      }

      steps.push(step2);
    }

    const transactions: StatusData['transactions'] = [];
    if (snapshot.source.txHash) {
      transactions.push({
        hash: snapshot.source.txHash,
        chainId: snapshot.source.chainId,
        status: step1Status === 'SUCCESS' ? 'confirmed' : 'pending',
        confirmations: step1Status === 'SUCCESS' ? 20 : 0,
        explorerUrl: snapshot.source.explorerUrl || '',
      });
    }
    if (snapshot.bridge?.destTxHash && snapshot.bridge?.destChainId) {
      transactions.push({
        hash: snapshot.bridge.destTxHash,
        chainId: snapshot.bridge.destChainId,
        status: 'confirmed',
        confirmations: 5,
        explorerUrl: snapshot.bridge.destExplorerUrl || '',
      });
    }

    const statusData: StatusData = {
      executionId,
      status: {
        overall,
        currentStep:
          overall === 'SUCCESS'
            ? totalSteps
            : step1Success
              ? Math.min(2, totalSteps)
              : 1,
        totalSteps,
        progressPercentage: Math.max(0, Math.min(100, progress)),
      },
      steps,
      transactions,
      // Add bridge monitoring details
      bridgeMonitoring:
        isCrossChain && snapshot.bridge
          ? {
              status: snapshot.bridge.status,
              statusUrl: snapshot.bridge.statusUrl,
              lastCheckedAt: snapshot.bridge.lastCheckedAt
                ? new Date(snapshot.bridge.lastCheckedAt).toISOString()
                : undefined,
              checkCount: snapshot.bridge.checkCount || 0,
              errorCount: snapshot.bridge.errorCount || 0,
              lastError: snapshot.bridge.lastError,
              estimatedCompletionTime:
                snapshot.bridge.etaMs && snapshot.bridge.startedAt
                  ? new Date(
                      snapshot.bridge.startedAt + snapshot.bridge.etaMs,
                    ).toISOString()
                  : undefined,
            }
          : undefined,
      // Add status history
      statusHistory: snapshot.statusHistory?.map((h) => ({
        timestamp: new Date(h.timestamp).toISOString(),
        status: h.status,
        details: h.details,
      })),
    } as any;

    const metadata: ResponseMetadata = {
      swapType: snapshot.swapType,
      providerCategory: isCrossChain ? 'meta' : 'auto',
      estimatedTime: isCrossChain
        ? Math.round((snapshot.bridge?.etaMs || 30 * 60 * 1000) / 1000)
        : 30,
      complexity: isCrossChain ? 'complex' : 'simple',
      timestamp: new Date().toISOString(),
      executionId,
    };

    return { success: true, data: statusData, metadata };
  }

  /**
   * Manually refresh execution status (force immediate bridge status check)
   */
  async refreshExecutionStatus(executionId: string): Promise<boolean> {
    const snapshot = await this.stateService.getExecutionSnapshot(executionId);
    if (!snapshot || snapshot.swapType !== SwapType.CROSS_CHAIN) {
      return false;
    }

    return await this.bridgeTracker.refreshStatus(executionId);
  }

  /**
   * Normalize wallet addresses
   */
  private normalizeWalletAddresses(
    request: ExtendedSwapRequest,
  ): ExtendedSwapRequest {
    const normalized = { ...request } as ExtendedSwapRequest;

    // Try to derive from private key if not provided
    if (!normalized.taker && !normalized.userWallet) {
      if (!normalized.privateKey) {
        throw new BadRequestException(
          'User wallet address is required. Provide taker or userWallet, or ensure privateKey can derive an address.',
        );
      }

      try {
        const account = getAccountFromPrivateKey(normalized.privateKey);
        normalized.taker = account?.address || '';
        normalized.userWallet = normalized.taker;
        if (!normalized.taker) {
          throw new Error('Could not derive wallet address from private key');
        }
      } catch (e) {
        throw new BadRequestException(
          'User wallet address is required. Provide taker or userWallet, or ensure privateKey can derive an address.',
        );
      }
    }

    // Normalize wallet fields
    normalized.taker = normalized.taker || normalized.userWallet || '';
    normalized.userWallet = normalized.userWallet || normalized.taker;
    normalized.recipient =
      normalized.recipient || normalized.receiver || normalized.taker;
    normalized.receiver =
      normalized.receiver || normalized.recipient || normalized.taker;

    return normalized;
  }

  /**
   * Enrich token information
   */
  private enrichTokenInformation(request: UniversalSwapRequestDto): void {
    const enrichedSellToken = this.unifiedConfigService.enrichTokenInfo(
      request.sellToken,
    );
    const enrichedBuyToken = this.unifiedConfigService.enrichTokenInfo(
      request.buyToken,
    );

    if (enrichedSellToken?.address) {
      request.sellToken.address = enrichedSellToken.address;
      request.sellToken.standard = enrichedSellToken.standard;
      request.sellToken.decimals = enrichedSellToken.decimals;
    }
    if (enrichedBuyToken?.address) {
      request.buyToken.address = enrichedBuyToken.address;
      request.buyToken.standard = enrichedBuyToken.standard;
      request.buyToken.decimals = enrichedBuyToken.decimals;
    }

    if (!request.sellToken?.address || !request.buyToken?.address) {
      throw new BadRequestException(
        'Could not resolve token addresses (provide valid token symbols or explicit contract addresses)',
      );
    }

    // Normalize token addresses for EVM
    try {
      if (request.sellToken.chain.ecosystem === 'evm') {
        request.sellToken.address =
          this.validationService.normalizeAndValidateTokenAddress(
            request.sellToken.address,
            request.sellToken.chain.ecosystem,
          );
      }
      if (request.buyToken.chain.ecosystem === 'evm') {
        request.buyToken.address =
          this.validationService.normalizeAndValidateTokenAddress(
            request.buyToken.address,
            request.buyToken.chain.ecosystem,
          );
      }
    } catch (e) {
      throw new BadRequestException(
        `Invalid token address format: ${e.message}`,
      );
    }
  }

  /**
   * Prepare route (validate steps, generate routeId)
   */
  private prepareRoute(route: any, request: UniversalSwapRequestDto): void {
    // Validate route steps
    if (!route.steps || route.steps.length === 0 || !route.steps[0].chainId) {
      this.logger.warn(
        `Route steps missing or malformed, synthesizing single step...`,
      );
      const srcChainId = normalizeChainId(request.sellToken.chain.chainId);
      route.steps = [
        {
          kind: 'swap',
          chainId: srcChainId,
          details: {
            provider: route.provider || 'evm',
            fromToken: request.sellToken.address!,
            toToken: request.buyToken.address!,
            fromChain: normalizeChainId(request.sellToken.chain.chainId),
            toChain: normalizeChainId(request.buyToken.chain.chainId),
            estimatedTime: route.estimatedTime || 30,
          },
          action: 'swap',
          provider: route.provider || 'evm',
          fromToken: request.sellToken.address!,
          toToken: request.buyToken.address!,
          fromChain: normalizeChainId(request.sellToken.chain.chainId),
          toChain: normalizeChainId(request.buyToken.chain.chainId),
          estimatedTime: route.estimatedTime || 30,
        },
      ];
    }

    // Generate routeId if not present
    if (!route.routeId) {
      route.routeId = `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    if (!route.providerRef && route.metadata?.originalQuote) {
      route.providerRef = route.metadata.originalQuote;
    }
  }

  /**
   * Build tracking URLs
   */
  private buildTrackingUrls(
    executionResult: ExecutionResult,
  ): Array<{ chain: string; url: string; description: string }> {
    const trackingUrls: Array<{
      chain: string;
      url: string;
      description: string;
    }> = [];

    if (executionResult.explorerUrl) {
      trackingUrls.push({
        chain: executionResult.chainId.toString(),
        url: executionResult.explorerUrl,
        description: 'Source Transaction',
      });
    }
    if (executionResult.bridgeStatusUrl) {
      trackingUrls.push({
        chain: executionResult.chainId.toString(),
        url: executionResult.bridgeStatusUrl,
        description: 'Bridge Status',
      });
    }
    if (executionResult.destExplorerUrl && executionResult.destChainId) {
      trackingUrls.push({
        chain: executionResult.destChainId.toString(),
        url: executionResult.destExplorerUrl,
        description: 'Destination Transaction',
      });
    }

    return trackingUrls;
  }

  /**
   * Build execution response (basic or enhanced)
   */
  private async buildExecutionResponse(
    executionId: string,
    executionResult: ExecutionResult,
    executionContext: ExecutionContext,
    selectedRoute: any,
    executor: any,
    trackingUrls: any[],
    startTime: number,
    enhanced?: boolean,
  ): Promise<ExecutionData | EnhancedExecutionData> {
    // If enhanced flag is set, use enhanced response builder
    if (enhanced) {
      try {
        const enhancedData =
          await this.enhancedResponseBuilder.buildEnhancedResponse(
            executionId,
            executionResult,
            executionContext,
            startTime,
          );
        return enhancedData;
      } catch (error) {
        this.logger.warn(
          `Failed to build enhanced response, falling back to basic: ${error.message}`,
        );
        // Fall through to basic response
      }
    }

    // Build basic execution response
    // CRITICAL: For cross-chain swaps, the response represents SOURCE transaction completion,
    // but the BRIDGE is still in progress. The client must poll /status endpoint to track bridge completion.
    const isCrossChain =
      selectedRoute.steps?.length > 1 &&
      selectedRoute.steps[0]?.chainId !==
        selectedRoute.steps[selectedRoute.steps.length - 1]?.chainId;

    // For cross-chain swaps: Mark as IN_PROGRESS even if source tx succeeded
    // The overall status becomes SUCCESS only after bridge completes (tracked in background)
    const overallStatus = executionResult.success
      ? isCrossChain
        ? 'IN_PROGRESS'
        : 'SUCCESS'
      : 'FAILED';

    const progressPercentage = executionResult.success
      ? isCrossChain
        ? 50
        : 100 // Cross-chain: 50% after source tx, 100% after bridge
      : 0;

    return {
      executionId,
      transactionHashes: executionResult.transactionHash
        ? [executionResult.transactionHash]
        : [],
      status: {
        overall: overallStatus,
        currentStep: isCrossChain ? 1 : selectedRoute.steps?.length || 1,
        totalSteps: selectedRoute.steps?.length || 1,
        progressPercentage,
      },
      steps: (selectedRoute.steps || []).map((step: any, index: number) => ({
        step: index + 1,
        action: step.kind || 'swap',
        status:
          index === 0 && executionResult.success
            ? 'SUCCESS'
            : index === 0 && !executionResult.success
              ? 'FAILED'
              : 'IN_PROGRESS', // Future steps are IN_PROGRESS for cross-chain
        chainId: step.chainId || 1,
        chainName: getChainName(step.chainId || 1),
        provider: step.protocol || executor.getName(),
        estimatedTime: step.estimatedTime || 30,
        transactionHash:
          index === 0 ? executionResult.transactionHash : undefined,
      })),
      estimatedCompletion: isCrossChain
        ? new Date(
            Date.now() + (selectedRoute.etaSeconds || 30 * 60) * 1000,
          ).toISOString()
        : new Date().toISOString(),
      trackingUrls,
      // Add helpful message for cross-chain swaps
      message: isCrossChain
        ? `Source transaction confirmed. Bridge in progress. Poll /status endpoint with executionId to track completion.`
        : undefined,
    } as ExecutionData;
  }

  /**
   * Determine swap type from route
   */
  private determineSwapTypeFromRoute(route: any): SwapType {
    if (!route.steps || route.steps.length === 0) {
      return SwapType.ON_CHAIN;
    }

    const firstStep = route.steps[0];
    const lastStep = route.steps[route.steps.length - 1];

    if (firstStep.fromChain !== lastStep.toChain) {
      return SwapType.CROSS_CHAIN;
    }

    return SwapType.ON_CHAIN;
  }

  /**
   * Create error metadata
   */
  private createErrorMetadata(): ResponseMetadata {
    return {
      swapType: SwapType.ON_CHAIN,
      providerCategory: 'unknown',
      estimatedTime: 0,
      complexity: 'unknown',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Detect ecosystem from a chainId (numeric or string) – lightweight helper for balance probing.
   * Mirrors logic used in MetaSwapExecutor but simplified.
   */
  private detectEcosystemFromChainId(
    chainId: number | string,
  ): 'evm' | 'solana' | 'bitcoin' | 'tron' {
    // Handle Rubic's internal chain IDs (numeric)
    if (chainId === 7565164 || chainId === '7565164') return 'solana'; // Rubic's Solana ID
    if (chainId === 5555 || chainId === '5555') return 'bitcoin'; // Rubic's Bitcoin ID
    if (chainId === 8453 || chainId === '8453') return 'evm'; // Base (EVM)

    // Handle string-based chain IDs
    const idStr = chainId.toString().toLowerCase();
    if (idStr.includes('solana')) return 'solana';
    if (
      idStr.includes('bitcoin') ||
      idStr === 'btc' ||
      idStr.includes('litecoin') ||
      idStr === 'ltc' ||
      idStr.includes('doge')
    )
      return 'bitcoin';
    if (idStr.includes('tron') || idStr === 'trx') return 'tron';
    // Default to EVM (most chains are EVM-compatible)
    return 'evm';
  }
}
