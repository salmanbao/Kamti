import {
  Controller,
  Post,
  Get,
  Query,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  Inject,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import {
  UniversalSwapRequestDto,
  UniversalSwapResponseDto,
  SwapType,
  BlockchainEcosystem,
} from '@swap/dto/universal-swap-request.dto';
import { SwapRoutingService } from '@swap/services/core/swap-routing.service';
import { AggregatorManagerService } from '@swap/services/core/aggregation/aggregator-manager.service';
import { ApprovalService } from '@swap/services/blockchain/approval/approval.service';
import { QuoteService } from '@swap/services/core/execution/quote.service';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import {
  ApprovalRequestDto,
  ApprovalStatusRequestDto,
} from '@swap/dto/approval-request.dto';
import { AggregatorType } from '@swap/models/swap-request.model';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  AmountNormalizationUtils,
  ProviderAmountFormat,
} from '@shared/utils/amount-normalization.utils';
import { APPROVED_INPUT_TOKENS } from '@shared/config/unified-token-configuration.config';
import { SkipTokenValidation } from '../../core/guards/token-validation.guard';
import { CapabilityCheckRequestDto } from '@swap/dto/capability-check.dto';
import {
  UniversalResponse,
  CapabilityCheckData,
  ExecutionData,
  StatusData,
  ResponseMetadata,
} from '@swap/dto/universal-response.dto';
import { SwapExecutorFactory } from '@swap/services/core/execution/executors/swap-executor-factory';
import { validateRecipientAddress } from '@shared/utils/validation.utils';
import { EnhancedResponseBuilderService } from '@swap/services/core/execution/enhanced-response-builder.service';
import { ProviderHealthService } from '@shared/services/provider-health.service';
import { EnhancedExecutionData } from '@swap/dto/enhanced-execution-response.dto';
import { SwapOrchestrationService } from '@swap/services/core/orchestration/swap-orchestration.service';
import { SwapValidationService } from '@swap/services/core/validation/swap-validation.service';
import { ExecutionStateService } from '@swap/services/core/state/execution-state.service';
import { TraceLoggerService } from '@shared/services/trace-logger.service';
import type { IQueueService } from '@swap/services/queue/queue.interface';
import { JobProgress, JobResult } from '@swap/services/queue/queue.interface';
import {
  AsyncExecutionResponseDto,
  TraceStatusResponseDto,
  TraceLogsResponseDto,
  WorkflowStatusResponseDto,
} from '@swap/dto/workflow-status.dto';

/**
 * Universal Swap Controller
 * Handles all types of swaps: on-chain, cross-chain, L1-L2, native L1, etc.
 * Intelligently routes requests to appropriate provider categories
 */
@Controller('universal-swap')
@ApiTags('Universal Swap')
export class UniversalSwapController {
  private readonly logger: WinstonLoggerService;

  constructor(
    private readonly orchestrationService: SwapOrchestrationService,
    private readonly validationService: SwapValidationService,
    private readonly stateService: ExecutionStateService,
    private readonly quoteService: QuoteService,
    private readonly winstonLogger: WinstonLoggerService,
    private readonly traceLogger: TraceLoggerService,
    // Temporary: Keep these for pre-check and other endpoints that haven't been fully refactored yet
    private readonly swapRoutingService: SwapRoutingService,
    private readonly aggregatorManager: AggregatorManagerService,
    private readonly approvalService: ApprovalService,
    private readonly walletService: WalletService,
    private readonly unifiedConfigService: UnifiedConfigurationService,
    private readonly amountUtils: AmountNormalizationUtils,
    private readonly executorFactory: SwapExecutorFactory,
    private readonly enhancedResponseBuilder: EnhancedResponseBuilderService,
    private readonly providerHealth: ProviderHealthService,
    @Optional()
    @Inject('IQueueService')
    private readonly queueService?: IQueueService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(UniversalSwapController.name);
  }

  /**
   * STEP 1: Universal Capability Check - Validates chain/token support and recommends providers
   */
  @Post('capabilities')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check swap capabilities and provider recommendations',
    description: `
    Universal capability check that validates:
    
    • **Chain Support**: Source and destination chain compatibility
    • **Token Support**: Input token restrictions and output token availability  
    • **Provider Recommendations**: Best providers for the swap request
    • **Liquidity Analysis**: Available liquidity across providers
    
    This endpoint should be called first to ensure the swap is possible and get 
    provider recommendations before requesting quotes.
    
    **Input Token Restrictions**: Only 13 approved tokens can be used as sellToken:
    ${APPROVED_INPUT_TOKENS.join(', ')}
    
    **Output Tokens**: No restrictions - any token supported by integrated providers.
    `,
  })
  @ApiBody({ type: CapabilityCheckRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Capability check completed successfully',
    type: UniversalResponse,
  })
  @SkipTokenValidation()
  async checkCapabilities(
    @Body() request: CapabilityCheckRequestDto,
  ): Promise<UniversalResponse<CapabilityCheckData>> {
    this.logger.log(
      `Capability check: ${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId} -> ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId}`,
    );

    try {
      return await this.orchestrationService.checkCapabilities(request);
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
   * STEP 2: Universal quote endpoint - handles all swap scenarios
   */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get universal swap quote',
    description: `
    Universal endpoint that can handle all types of cryptocurrency swaps:
    
    • **On-chain swaps**: Same blockchain, same ecosystem (e.g., ETH -> USDT on Ethereum)
    • **Cross-chain swaps**: Different blockchains, different ecosystems (e.g., ETH -> SOL)
    • **L1-L2 swaps**: Layer 1 to Layer 2 and vice versa (e.g., ETH mainnet -> Arbitrum)
    • **Native L1 swaps**: Bitcoin/THORChain/Maya native routing (e.g., BTC -> ETH via THORChain)
    
    The system automatically:
    1. Analyzes the request to determine swap type
    2. Validates chain compatibility
    3. Routes to appropriate provider category
    4. Returns best routes with execution details
    
    **Supported Ecosystems:**
    - EVM: Ethereum, Polygon, BSC, Arbitrum, Optimism, Base, etc.
    - Solana: SPL tokens and native SOL
    - Cosmos: IBC-enabled chains
    - Bitcoin: Native Bitcoin and wrapped variants
    - THORChain/Maya: Native cross-chain swaps
    `,
  })
  @ApiBody({ type: UniversalSwapRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Quote retrieved successfully with route options',
    type: UniversalSwapResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request parameters or unsupported swap combination',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Unsupported swap type: EVM chain 999 not supported',
        },
        error: { type: 'string', example: 'BadRequest' },
        statusCode: { type: 'number', example: 400 },
      },
    },
  })
  async getUniversalQuote(
    @Body() request: UniversalSwapRequestDto,
  ): Promise<UniversalSwapResponseDto> {
    this.logger.log(
      `Universal quote request: ${request.sellToken.symbol} on ${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId} -> ${request.buyToken.symbol} on ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId}`,
    );

    try {
      const result = await this.orchestrationService.getUniversalQuote(request);

      // Return structured response
      return {
        swapType: result.swapType,
        routes: result.routes,
        recommendedRoute: result.routes[0], // Best route (highest quality score)
        transactionData: result.routes[0]?.transactionData || null,
        warnings: [], // Warnings can be added later if needed
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
   * Universal pre-check endpoint - validates parameters, liquidity, approval, wallet balance, provider health
   */
  @Post('pre-check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Universal pre-check for swap',
    description: `Performs pre-checks for a swap request: parameter validation, liquidity, approval, wallet balance, and provider health. Returns status and warnings for each check.`,
  })
  @ApiBody({ type: UniversalSwapRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Pre-check results with status and warnings',
    schema: {
      type: 'object',
      properties: {
        parametersValid: { type: 'boolean' },
        liquidityAvailable: { type: 'boolean' },
        approvalRequired: { type: 'boolean' },
        sufficientBalance: { type: 'boolean' },
        providerHealthy: { type: 'boolean' },
        warnings: { type: 'array', items: { type: 'string' } },
        details: { type: 'object' },
      },
    },
  })
  async universalPreCheck(@Body() request: UniversalSwapRequestDto) {
    this.logger.log(
      `Universal pre-check request: ${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId} -> ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId}`,
    );

    const warnings: string[] = [];
    const details: Record<string, any> = {};

    // Step 0: Enrich token info from unified configuration (same as quote endpoint)
    let enrichedSellToken: any = null;
    let enrichedBuyToken: any = null;

    try {
      enrichedSellToken = this.unifiedConfigService.enrichTokenInfo(
        request.sellToken,
      );
      enrichedBuyToken = this.unifiedConfigService.enrichTokenInfo(
        request.buyToken,
      );

      if (enrichedSellToken) {
        request.sellToken.address = enrichedSellToken.address;
        request.sellToken.standard = enrichedSellToken.standard;
        request.sellToken.decimals = enrichedSellToken.decimals;
        this.logger.debug(
          `Enriched sell token: ${enrichedSellToken.symbol} (${enrichedSellToken.address}) - ${enrichedSellToken.decimals} decimals`,
        );
      }

      if (enrichedBuyToken) {
        request.buyToken.address = enrichedBuyToken.address;
        request.buyToken.standard = enrichedBuyToken.standard;
        request.buyToken.decimals = enrichedBuyToken.decimals;
        this.logger.debug(
          `Enriched buy token: ${enrichedBuyToken.symbol} (${enrichedBuyToken.address}) - ${enrichedBuyToken.decimals} decimals`,
        );
      }
    } catch (e) {
      this.logger.warn(`Token enrichment failed: ${e.message}`);
      warnings.push('Token enrichment failed - some checks may be incomplete');
    }

    // Step 1: Determine swap routing (same logic as quote endpoint)
    let swapType: SwapType | null = null;
    let providerCategory: string | null = null;

    try {
      swapType = this.swapRoutingService.determineSwapType(request);
      providerCategory = this.swapRoutingService.determineProviderCategory(
        swapType,
        request,
      );
      this.logger.debug(
        `Pre-check routing: ${swapType} -> ${providerCategory}`,
      );

      details.routing = {
        swapType,
        providerCategory,
        ecosystem: request.sellToken.chain.ecosystem,
      };
    } catch (e) {
      this.logger.warn(`Routing determination failed: ${e.message}`);
      warnings.push(
        'Routing determination failed - provider-specific checks may be incomplete',
      );
    }

    // Step 2: Parameter validation
    let parametersValid: boolean | null = null;
    try {
      this.amountUtils.validateAmount(request.sellAmount);

      if (!enrichedSellToken) {
        warnings.push(
          `Sell token ${request.sellToken.symbol} is not configured or not available on chain ${request.sellToken.chain.chainId}`,
        );
      }

      if (!enrichedBuyToken) {
        warnings.push(
          `Buy token ${request.buyToken.symbol} is not configured or not available on chain ${request.buyToken.chain.chainId}`,
        );
      }

      parametersValid =
        this.swapRoutingService.validateChainCompatibility(request);
      if (!parametersValid)
        warnings.push('Unsupported chain combination for swap');
    } catch (e) {
      parametersValid = false;
      warnings.push('Parameter validation failed: ' + e.message);
    }

    details.parametersValid = parametersValid;
    details.tokenEnrichment = {
      sellTokenEnriched: !!enrichedSellToken,
      buyTokenEnriched: !!enrichedBuyToken,
      sellTokenAddress: request.sellToken.address,
      buyTokenAddress: request.buyToken.address,
    };

    // Step 2.1: Recipient validation (destination chain)
    if (request.recipient) {
      try {
        validateRecipientAddress(
          request.buyToken.chain.ecosystem,
          request.buyToken.chain.chainId,
          request.recipient,
        );
        details.recipientValid = true;
      } catch (e) {
        details.recipientValid = false;
        warnings.push(
          `Invalid recipient for ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId} — ${e.message}`,
        );
      }
    }

    // Step 3: Liquidity check (provider-specific) - store quote data for reuse
    let liquidityAvailable: boolean | null = null;
    let cachedQuoteData: any = null;
    try {
      this.logger.debug('Checking liquidity for pre-check');
      const liquidityResult = await this.checkLiquidityByProviderWithCache(
        providerCategory,
        request,
        warnings,
      );
      liquidityAvailable = liquidityResult.hasLiquidity;
      cachedQuoteData = liquidityResult.quoteData;
    } catch (e) {
      liquidityAvailable = false;
      warnings.push('Liquidity check failed: ' + e.message);
    }
    details.liquidityAvailable = liquidityAvailable;

    // Step 4: Approval check (ecosystem-specific) - reuse cached quote data
    let approvalRequired: boolean | null = null;
    try {
      this.logger.debug('Checking token approval for pre-check');
      approvalRequired = await this.checkApprovalByEcosystem(
        request,
        providerCategory,
        warnings,
        details,
        cachedQuoteData,
      );
    } catch (e) {
      approvalRequired = false;
      warnings.push('Approval check failed: ' + e.message);
    }
    details.approvalRequired = approvalRequired;

    // Step 5: Wallet balance check (ecosystem-specific)
    let sufficientBalance: boolean | null = null;
    try {
      this.logger.debug('Checking wallet balance for pre-check');
      sufficientBalance = await this.checkBalanceByEcosystem(
        request,
        warnings,
        details,
      );
    } catch (e) {
      sufficientBalance = false;
      warnings.push('Wallet balance check failed: ' + e.message);
    }
    details.sufficientBalance = sufficientBalance;

    // Step 6: Provider health check (provider-specific)
    let providerHealthy: boolean | null = null;
    try {
      this.logger.debug('Checking provider health for pre-check');
      // Check aggregated provider health metrics
      const summaries = this.providerHealth
        .getAllSummaries()
        .filter((s) => s !== null);
      if (summaries.length === 0) {
        providerHealthy = null; // No metrics yet
        warnings.push('No provider health metrics available yet');
      } else {
        // Consider providers healthy if at least one has success rate >= 0.8 and p95 latency < 10s
        const healthyProviders = summaries.filter(
          (s) =>
            s.successRate >= 0.8 && (!s.p95Latency || s.p95Latency < 10000),
        );
        providerHealthy = healthyProviders.length > 0;
        if (!providerHealthy) {
          warnings.push(
            'All providers have low success rates or high latencies',
          );
        }
        details.providerHealthSummary = {
          total: summaries.length,
          healthy: healthyProviders.length,
          providers: summaries.map((s) => ({
            name: s.name,
            status: s.status,
            successRate: s.successRate,
            p95Latency: s.p95Latency,
          })),
        };
      }
    } catch (e) {
      providerHealthy = false;
      warnings.push('Provider health check failed: ' + e.message);
    }
    details.providerHealthy = providerHealthy;

    return {
      parametersValid,
      liquidityAvailable,
      approvalRequired,
      sufficientBalance,
      providerHealthy,
      warnings,
      details,
    };
  }

  /**
   * Provider health metrics
   */
  @Get('provider-health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get provider health metrics',
    description:
      'Returns success rates and latency percentiles for providers. Optionally filter by provider name.',
  })
  @ApiQuery({
    name: 'provider',
    required: false,
    description: 'Provider name to filter (e.g., odos, 0x, rubic)',
  })
  async getProviderHealth(@Query('provider') provider?: string) {
    try {
      if (provider) {
        const summary = this.providerHealth.getProviderSummary(provider);
        if (!summary) {
          return {
            success: false,
            error: `No metrics for provider '${provider}'`,
          };
        }
        return { success: true, data: summary };
      }
      return { success: true, data: this.providerHealth.getAllSummaries() };
    } catch (error) {
      this.logger.error(
        `Provider health retrieval failed: ${error.message}`,
        error.stack,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Universal swap execution endpoint
   * Executes swaps using Strategy Pattern with ecosystem-specific executors
   *
   * Provider Preference Strategy:
   * - For EVM swaps (same chain): Symbiosis > Rubic > EVM aggregators (0x/Odos)
   *   Symbiosis is primary for best liquidity and feature support
   *   Rubic is secondary as cross-chain specialist
   *   EVM aggregators (0x, Odos) are tertiary for EVM-only optimization
   *
   * - For cross-chain swaps: Symbiosis > Rubic
   *   Both support bridging, but Symbiosis is now preferred for better rates
   *
   * - For native assets (BTC, SOL, etc.): Rubic is primary
   *   Rubic supports 70+ blockchains including native L1 chains
   *
   * Users can override preferences with preferredAggregator parameter
   */
  @Post('execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Execute universal swap',
    description:
      'Execute a swap across any supported ecosystem. Provides full token and chain information in the request body. ' +
      'Supports on-chain swaps, cross-chain swaps, and native L1 swaps. ' +
      'Automatically routes to the appropriate executor based on swap type. ' +
      'Provider preference order: For EVM swaps - Symbiosis > Rubic > 0x/Odos. For cross-chain - Symbiosis > Rubic. For native L1 - Rubic.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        sellToken: {
          type: 'object',
          description: 'Sell token information',
          properties: {
            symbol: { type: 'string', example: 'ETH' },
            address: {
              type: 'string',
              example: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
            },
            chain: {
              type: 'object',
              properties: {
                ecosystem: {
                  type: 'string',
                  enum: ['evm', 'solana', 'bitcoin', 'tron'],
                  example: 'evm',
                },
                chainId: {
                  oneOf: [{ type: 'number' }, { type: 'string' }],
                  example: 1,
                },
              },
            },
          },
        },
        buyToken: {
          type: 'object',
          description: 'Buy token information',
          properties: {
            symbol: { type: 'string', example: 'USDT' },
            address: {
              type: 'string',
              example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
            },
            chain: {
              type: 'object',
              properties: {
                ecosystem: {
                  type: 'string',
                  enum: ['evm', 'solana', 'bitcoin', 'tron'],
                  example: 'evm',
                },
                chainId: {
                  oneOf: [{ type: 'number' }, { type: 'string' }],
                  example: 1,
                },
              },
            },
          },
        },
        sellAmount: {
          type: 'string',
          description: 'Amount to sell (in smallest unit, e.g., wei for ETH)',
          example: '1000000000000000',
        },
        taker: {
          type: 'string',
          description: 'Wallet address executing the swap (alias: userWallet)',
        },
        userWallet: {
          type: 'string',
          description: 'Wallet address executing the swap (alias: taker)',
        },
        recipient: {
          type: 'string',
          description:
            'Recipient address to receive output amount (alias: receiver)',
        },
        receiver: {
          type: 'string',
          description:
            'Recipient address to receive output amount (alias: recipient)',
        },
        privateKey: {
          type: 'string',
          description: 'Private key for signing (server-side execution)',
        },
        slippageToleranceBps: {
          type: 'number',
          description: 'Slippage tolerance in basis points (e.g., 500 = 5%)',
          example: 500,
        },
        swapFullBalance: {
          type: 'boolean',
          description:
            'Swap full balance flag — when true, automatically adjusts swap amount to account for gas fees. ' +
            'Applies to native account-based chains (EVM natives like ETH/BNB/AVAX, and SOL/TRX). ' +
            'Not applicable to Bitcoin (UTXO-based). The system reduces the swap amount by estimated gas to ensure success.',
          example: false,
          default: false,
        },
        preferredAggregator: {
          type: 'string',
          description:
            'Preferred aggregator for execution (override automatic selection). ' +
            'Supported values: "symbiosis", "rubic", "0x", "odos". ' +
            'For EVM swaps: Symbiosis recommended (primary) > Rubic (secondary) > 0x/Odos (tertiary). ' +
            'For cross-chain: Symbiosis > Rubic. For native L1 (BTC, SOL): Rubic.',
          enum: ['symbiosis', 'rubic', '0x', 'odos'],
          example: 'symbiosis',
        },
        async: {
          type: 'boolean',
          description:
            'Enable asynchronous execution — when true, the request is queued for background processing ' +
            'and returns immediately with a trace ID for status tracking. Requires Redis queue to be configured ' +
            '(REDIS_URL and QUEUE_ENABLED=true). Use /trace-status/:traceId endpoint to track progress. ' +
            'When false or omitted, executes synchronously and returns the complete result.',
          example: false,
          default: false,
        },
        webhookUrl: {
          type: 'string',
          description:
            'Webhook URL for async execution completion notification (only used when async=true). ' +
            'The system will POST the execution result to this URL when the swap completes or fails. ' +
            'Webhook payload includes: { traceId, executionId, success, data, error, timestamp }.',
          example: 'https://your-api.com/webhooks/swap-complete',
        },
        priority: {
          type: 'number',
          description:
            'Job priority for async execution (only used when async=true). ' +
            'Lower numbers = higher priority. Range: 1-10. Default: 5. ' +
            'High priority jobs (1-3) are processed before lower priority jobs.',
          example: 5,
          default: 5,
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['sellToken', 'buyToken', 'sellAmount', 'privateKey'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Swap execution completed successfully',
    schema: {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          example: true,
          description: 'Whether the execution was successful',
        },
        data: {
          type: 'object',
          description: 'Execution data with detailed swap information',
          properties: {
            executionId: {
              type: 'string',
              example: 'exec_1234567890',
              description: 'Unique execution ID for tracking',
            },
            swapDirection: {
              type: 'object',
              description: 'Swap direction with chain information',
              properties: {
                from: {
                  type: 'object',
                  properties: {
                    token: { type: 'string', example: 'ETH' },
                    address: {
                      type: 'string',
                      example: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
                    },
                    chainId: {
                      oneOf: [{ type: 'number' }, { type: 'string' }],
                      example: 1,
                    },
                    chainName: { type: 'string', example: 'Ethereum' },
                    ecosystem: {
                      type: 'string',
                      enum: ['evm', 'solana', 'bitcoin', 'tron'],
                      example: 'evm',
                    },
                  },
                },
                to: {
                  type: 'object',
                  properties: {
                    token: { type: 'string', example: 'USDT' },
                    address: {
                      type: 'string',
                      example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
                    },
                    chainId: {
                      oneOf: [{ type: 'number' }, { type: 'string' }],
                      example: 1,
                    },
                    chainName: { type: 'string', example: 'Ethereum' },
                    ecosystem: {
                      type: 'string',
                      enum: ['evm', 'solana', 'bitcoin', 'tron'],
                      example: 'evm',
                    },
                  },
                },
                isCrossChain: { type: 'boolean', example: false },
              },
            },
            swapType: {
              type: 'string',
              enum: ['on-chain', 'cross-chain', 'native-swap'],
              example: 'on-chain',
              description: 'Type of swap executed',
            },
            providerCategory: {
              type: 'string',
              enum: [
                'evm-aggregator',
                'meta',
                'solana',
                'tron',
                'bitcoin',
                'native-l1',
                'unknown',
              ],
              example: 'meta',
              description: 'Category of provider used',
            },
            aggregator: {
              type: 'string',
              example: '0x',
              description: 'Name of the aggregator/provider used',
            },
            currencies: {
              type: 'object',
              description: 'Currency details for sell and buy tokens',
              properties: {
                sell: {
                  type: 'object',
                  properties: {
                    symbol: { type: 'string', example: 'ETH' },
                    address: { type: 'string' },
                    decimals: { type: 'number', example: 18 },
                    chainId: {
                      oneOf: [{ type: 'number' }, { type: 'string' }],
                    },
                    chainName: { type: 'string' },
                    ecosystem: { type: 'string' },
                    amount: {
                      type: 'object',
                      properties: {
                        raw: { type: 'string', example: '1000000000000000' },
                        formatted: { type: 'string', example: '0.001' },
                        symbol: { type: 'string', example: 'ETH' },
                      },
                    },
                  },
                },
                buy: {
                  type: 'object',
                  properties: {
                    symbol: { type: 'string', example: 'USDT' },
                    address: { type: 'string' },
                    decimals: { type: 'number', example: 6 },
                    chainId: {
                      oneOf: [{ type: 'number' }, { type: 'string' }],
                    },
                    chainName: { type: 'string' },
                    ecosystem: { type: 'string' },
                    estimatedAmount: {
                      type: 'object',
                      properties: {
                        raw: { type: 'string', example: '2000000' },
                        formatted: { type: 'string', example: '2.0' },
                        symbol: { type: 'string', example: 'USDT' },
                      },
                    },
                    minimumAmount: {
                      type: 'object',
                      properties: {
                        raw: { type: 'string', example: '1900000' },
                        formatted: { type: 'string', example: '1.9' },
                        symbol: { type: 'string', example: 'USDT' },
                      },
                    },
                  },
                },
              },
            },
            addresses: {
              type: 'object',
              description: 'Sender and receiver addresses',
              properties: {
                sender: {
                  type: 'string',
                  example: '0x10a700ea4f0d6f7Ec46AFa7eb2056db80a23d516',
                },
                recipient: {
                  type: 'string',
                  example: '0x10a700ea4f0d6f7Ec46AFa7eb2056db80a23d516',
                },
                finalReceiver: {
                  type: 'string',
                  example: '0x10a700ea4f0d6f7Ec46AFa7eb2056db80a23d516',
                },
              },
            },
            route: {
              type: 'object',
              description:
                'Route details including route ID, estimated gas, fees, and amounts',
              properties: {
                routeId: { type: 'string', example: 'route_1234567890_abc123' },
                provider: { type: 'string', example: '0x' },
                estimatedGas: { type: 'string', example: '21000' },
                estimatedOutputAmount: {
                  type: 'object',
                  properties: {
                    raw: { type: 'string', example: '2000000' },
                    formatted: { type: 'string', example: '2.0' },
                    symbol: { type: 'string', example: 'USDT' },
                  },
                },
                minimumOutputAmount: {
                  type: 'object',
                  properties: {
                    raw: { type: 'string', example: '1900000' },
                    formatted: { type: 'string', example: '1.9' },
                    symbol: { type: 'string', example: 'USDT' },
                  },
                },
                priceImpact: { type: 'string', example: '0.5' },
                slippage: {
                  oneOf: [{ type: 'number' }, { type: 'string' }],
                  example: 0.5,
                },
                etaSeconds: { type: 'number', example: 30 },
                gasDetails: {
                  type: 'object',
                  description: 'Detailed gas information',
                  properties: {
                    gasLimit: { type: 'string', example: '21000' },
                    gasCostWei: { type: 'string', example: '420000000000000' },
                    gasPrice: { type: 'string', example: '20000000000' },
                    maxFeePerGas: { type: 'string', example: '25000000000' },
                    maxPriorityFeePerGas: {
                      type: 'string',
                      example: '2000000000',
                    },
                  },
                },
                feeDetails: {
                  type: 'object',
                  description: 'Fee breakdown',
                  properties: {
                    providerFee: { type: 'string', example: '0' },
                    providerFeeUsd: {
                      oneOf: [{ type: 'number' }, { type: 'string' }],
                      example: 0,
                    },
                    bridgeFee: { type: 'string', example: '0' },
                    percentFeePercent: { type: 'number', example: 0 },
                    percentFeeToken: { type: 'string' },
                  },
                },
              },
            },
            transaction: {
              type: 'object',
              description:
                'Transaction execution details (blockchain-specific)',
              properties: {
                ecosystem: {
                  type: 'string',
                  enum: ['evm', 'solana', 'tron', 'bitcoin', 'unknown'],
                  example: 'evm',
                },
                transactionHash: { type: 'string', example: '0xabc123...' },
                blockNumber: { type: 'number', example: 12345678 },
                blockTimestamp: { type: 'string', format: 'date-time' },
                gasUsed: { type: 'string', example: '21000' },
                gasPrice: { type: 'string', example: '20000000000' },
                gasCost: { type: 'string', example: '420000000000000' },
                from: {
                  type: 'string',
                  example: '0x10a700ea4f0d6f7Ec46AFa7eb2056db80a23d516',
                },
                to: {
                  type: 'string',
                  example: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
                },
                value: { type: 'string', example: '1000000000000000' },
                nonce: { type: 'number', example: 42 },
                confirmations: { type: 'number', example: 12 },
                status: {
                  type: 'string',
                  enum: ['SUCCESS', 'FAILED', 'PENDING'],
                  example: 'SUCCESS',
                },
                signature: {
                  type: 'string',
                  description: 'Solana transaction signature',
                },
                slot: { type: 'number', description: 'Solana slot number' },
                blockTime: {
                  type: 'number',
                  description: 'Solana block timestamp',
                },
                computeUnitsConsumed: {
                  type: 'number',
                  description: 'Solana compute units consumed',
                },
                fee: { type: 'string', description: 'Solana transaction fee' },
              },
            },
            amountAdjustment: {
              type: 'object',
              description:
                'Amount adjustment details when swap amount was adjusted for gas fees',
              properties: {
                originalAmount: { type: 'string', example: '1000000000000000' },
                adjustedAmount: { type: 'string', example: '950000000000000' },
                gasCost: { type: 'string', example: '50000000000000' },
                reason: {
                  type: 'string',
                  example: 'User requested full balance swap',
                },
                originalOutputAmount: { type: 'string', example: '2000000' },
                adjustedOutputAmount: { type: 'string', example: '1900000' },
              },
            },
            transactionHashes: {
              type: 'array',
              items: { type: 'string' },
              example: ['0xabc123...'],
              description:
                'Transaction hashes (legacy field for backward compatibility)',
            },
            status: {
              type: 'object',
              description: 'Current execution status (legacy field)',
              properties: {
                overall: {
                  type: 'string',
                  enum: [
                    'PENDING',
                    'IN_PROGRESS',
                    'SUCCESS',
                    'FAILED',
                    'PARTIAL',
                  ],
                  example: 'SUCCESS',
                },
                currentStep: { type: 'number', example: 1 },
                totalSteps: { type: 'number', example: 1 },
                progressPercentage: { type: 'number', example: 100 },
              },
            },
            steps: {
              type: 'array',
              description: 'Execution steps with progress (legacy field)',
              items: {
                type: 'object',
                properties: {
                  step: { type: 'number', example: 1 },
                  action: { type: 'string', example: 'swap' },
                  status: {
                    type: 'string',
                    enum: ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED'],
                    example: 'SUCCESS',
                  },
                  chainId: {
                    oneOf: [{ type: 'number' }, { type: 'string' }],
                    example: 1,
                  },
                  chainName: { type: 'string', example: 'Ethereum' },
                  provider: { type: 'string', example: '0x' },
                  estimatedTime: { type: 'number', example: 30 },
                  transactionHash: { type: 'string', example: '0xabc123...' },
                },
              },
            },
            estimatedCompletion: {
              type: 'string',
              format: 'date-time',
              example: '2024-01-01T12:00:00Z',
              description: 'Estimated completion time (legacy field)',
            },
            trackingUrls: {
              type: 'array',
              description: 'Real-time tracking URLs for transactions',
              items: {
                type: 'object',
                properties: {
                  chain: { type: 'string', example: '1' },
                  url: {
                    type: 'string',
                    example: 'https://etherscan.io/tx/0xabc123...',
                  },
                  description: {
                    type: 'string',
                    example: 'Source Transaction',
                  },
                },
              },
            },
          },
        },
        metadata: {
          type: 'object',
          description: 'Operation metadata',
          properties: {
            swapType: {
              type: 'string',
              enum: ['on-chain', 'cross-chain', 'native-swap'],
              example: 'on-chain',
            },
            providerCategory: {
              type: 'string',
              enum: [
                'evm-aggregator',
                'meta',
                'solana',
                'tron',
                'bitcoin',
                'native-l1',
                'unknown',
              ],
              example: 'meta',
            },
            estimatedTime: { type: 'number', example: 30 },
            complexity: {
              type: 'string',
              enum: ['simple', 'moderate', 'complex'],
              example: 'simple',
            },
            timestamp: { type: 'string', format: 'date-time' },
            executionId: { type: 'string', example: 'exec_1234567890' },
          },
        },
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Warnings or important notes',
          example: [],
        },
        error: {
          type: 'object',
          description: 'Error details (only present if success = false)',
          properties: {
            code: {
              type: 'string',
              enum: ['INVALID_REQUEST', 'EXECUTION_FAILED'],
              example: 'EXECUTION_FAILED',
            },
            message: { type: 'string', example: 'Transaction failed' },
            details: { type: 'string', example: 'Error stack trace...' },
          },
        },
      },
    },
  })
  async executeUniversalSwap(
    @Body() request: any,
  ): Promise<
    | UniversalResponse<ExecutionData>
    | UniversalResponse<EnhancedExecutionData>
    | AsyncExecutionResponseDto
  > {
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const traceId = this.traceLogger.generateTraceId();
    const startTime = Date.now();
    
    this.logger.log(
      `🚀 Executing universal swap request -> executionId: ${executionId}, traceId: ${traceId}`,
    );

    // Audit log: execution request received
    this.winstonLogger.audit('SWAP_EXECUTE_REQUEST', {
      executionId,
      traceId,
      async: request?.async || false,
      userWallet: request?.userWallet || request?.taker,
      recipient: request?.recipient || request?.receiver,
      slippageToleranceBps: request?.slippageToleranceBps,
      sellToken: request?.sellToken?.symbol,
      buyToken: request?.buyToken?.symbol,
      finalOutputToken: request?.finalOutputToken?.symbol,
      swapFullBalance: request?.swapFullBalance,
      preferredAggregator: request?.preferredAggregator || 'auto',
      sellAmount: request?.sellAmount,
      timestamp: new Date().toISOString(),
    });

    // Debug log: Check swapFullBalance flag and preferred aggregator
    this.logger.debug('🔍 Request parameters received', {
      traceId,
      executionId,
      async: request?.async,
      swapFullBalance: request?.swapFullBalance,
      preferredAggregator: request?.preferredAggregator || 'auto',
      type: typeof request?.swapFullBalance,
      sellAmount: request?.sellAmount,
    });

    try {
      // Validate shared parameter: private key must be present
      if (!request?.privateKey) {
        this.winstonLogger.logTransaction({
          executionId,
          type: 'execute',
          userWallet: request?.userWallet || request?.taker || 'unknown',
          sellToken: request?.sellToken?.symbol || 'unknown',
          buyToken: request?.buyToken?.symbol || 'unknown',
          sellAmount: request?.sellAmount || '0',
          chainId: request?.sellToken?.chain?.chainId || 0,
          status: 'failed',
          error: 'Private key is required for server-side execution',
        });
        throw new BadRequestException(
          'Private key is required for server-side execution',
        );
      }

      // ASYNC EXECUTION: Return trace ID immediately and process in background
      if (request?.async === true) {
        // Check if queue service is available
        if (!this.queueService) {
          throw new BadRequestException(
            'Async execution not available. Queue service is not configured. Please set REDIS_URL and QUEUE_ENABLED=true.',
          );
        }

        this.logger.log(
          `📨 Async execution requested for traceId: ${traceId}`,
        );

        // Initialize workflow with steps
        const workflowSteps = [
          'Request Validation',
          'Token Enrichment',
          'Route Selection',
          'Quote Retrieval',
          'Approval Check',
          'Transaction Preparation',
          'Transaction Execution',
          'Confirmation Tracking',
          'Result Processing',
        ];

        this.traceLogger.initializeWorkflow(traceId, workflowSteps, {
          executionId,
          userWallet: request?.userWallet || request?.taker,
          sellToken: request?.sellToken?.symbol,
          buyToken: request?.buyToken?.symbol,
          async: true,
        });

        // Add job to queue
        const jobId = await this.queueService.addSwapJob(
          {
            executionId,
            request,
            userWallet: request?.userWallet || request?.taker,
            timestamp: Date.now(),
            webhookUrl: request?.webhookUrl,
          },
          {
            priority: request?.priority || 5,
            maxRetries: 3,
            timeout: 300000, // 5 minutes
          },
        );

        this.winstonLogger.audit('ASYNC_SWAP_QUEUED', {
          traceId,
          executionId,
          jobId,
          userWallet: request?.userWallet || request?.taker,
          timestamp: new Date().toISOString(),
        });

        // Return async response with trace ID
        const asyncResponse: AsyncExecutionResponseDto = {
          success: true,
          traceId,
          jobId,
          executionId,
          statusUrl: `/universal-swap/trace-status/${traceId}`,
          estimatedCompletionSeconds: 60,
          message:
            'Request accepted. Processing asynchronously. Use traceId to track progress.',
          timestamp: new Date().toISOString(),
        };

        return asyncResponse;
      }

      // SYNC EXECUTION: Process immediately with trace logging
      // Initialize workflow
      const workflowSteps = [
        'Request Validation',
        'Token Enrichment',
        'Route Selection',
        'Quote Retrieval',
        'Approval Check',
        'Transaction Preparation',
        'Transaction Execution',
        'Confirmation Tracking',
        'Result Processing',
      ];

      this.traceLogger.initializeWorkflow(traceId, workflowSteps, {
        executionId,
        userWallet: request?.userWallet || request?.taker,
        sellToken: request?.sellToken?.symbol,
        buyToken: request?.buyToken?.symbol,
        async: false,
      });

      // Delegate to orchestration service with trace context
      const result = await this.orchestrationService.executeSwap(
        request as UniversalSwapRequestDto,
        executionId,
        startTime,
        traceId,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `❌ Swap execution failed: ${error.message}`,
        error.stack,
      );

      // Audit log: execution error
      this.winstonLogger.error(
        `Swap execution failed for ${executionId}, traceId: ${traceId}`,
        error.stack,
        UniversalSwapController.name,
      );
      this.winstonLogger.audit('SWAP_EXECUTE_FAILED', {
        executionId,
        traceId,
        userWallet: request?.userWallet || request?.taker,
        sellToken: request?.sellToken?.symbol,
        buyToken: request?.buyToken?.symbol,
        errorName: error.name,
        errorMessage: error.message,
        executionTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        data: {
          executionId,
          transactionHashes: [],
          status: {
            overall: 'FAILED',
            currentStep: 0,
            totalSteps: 1,
            progressPercentage: 0,
          },
          steps: [],
          estimatedCompletion: new Date().toISOString(),
          trackingUrls: [],
        },
        metadata: this.createErrorMetadata(),
        error: {
          code:
            error instanceof BadRequestException
              ? 'INVALID_REQUEST'
              : 'EXECUTION_FAILED',
          message: error.message,
          details: error.stack,
        },
      };
    }
  }

  // Dead code removed: buildExecutionResponse, determineSwapTypeFromRoute
  // These methods are now handled by SwapOrchestrationService and ExecutionStateService

  /**
   * Check execution status
   */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check swap execution status',
    description:
      'Monitor the progress of a cross-chain or complex swap operation',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        executionId: {
          type: 'string',
          description: 'Execution ID from execute response',
        },
      },
      required: ['executionId'],
    },
  })
  async getSwapStatus(
    @Body() request: { executionId: string },
  ): Promise<UniversalResponse<StatusData>> {
    this.logger.log(`Checking swap status: ${request.executionId}`);

    try {
      return this.orchestrationService.getExecutionStatus(request.executionId);
    } catch (error) {
      this.logger.error(`Status check failed: ${error.message}`, error.stack);

      return {
        success: false,
        data: {} as StatusData,
        metadata: this.createErrorMetadata(),
        error: {
          code: 'STATUS_CHECK_FAILED',
          message: error.message,
          details: error,
        },
      };
    }
  }

  /**
   * Manual status refresh (force immediate check)
   */
  @Post('status/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually refresh cross-chain swap status',
    description:
      'Force an immediate status check for a cross-chain swap instead of waiting for background polling',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        executionId: {
          type: 'string',
          description: 'Execution ID from execute response',
        },
      },
      required: ['executionId'],
    },
  })
  async refreshSwapStatus(@Body() request: { executionId: string }) {
    this.logger.log(`Manual status refresh: ${request.executionId}`);

    try {
      const refreshed = await this.orchestrationService.refreshExecutionStatus(
        request.executionId,
      );
      if (!refreshed) {
        return {
          success: false,
          error: 'Execution not found or not a cross-chain swap',
        };
      }

      // Return updated status
      return this.orchestrationService.getExecutionStatus(request.executionId);
    } catch (error) {
      this.logger.error(`Status refresh failed: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get job status by job ID (for async executions)
   */
  @Get('job-status/:jobId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get async job status and progress',
    description: `
    Query the status and progress of an async swap job by job ID.
    
    This endpoint is useful for:
    • Polling job progress while waiting for webhook notification
    • Checking job status if webhook delivery fails
    • Monitoring long-running cross-chain swaps
    
    Returns job progress with execution details, current status, and progress percentage.
    For completed jobs, use the executionId to query /status endpoint for full swap details.
    `,
  })
  @ApiQuery({
    name: 'jobId',
    required: true,
    type: String,
    description: 'Job ID returned from async execution request',
  })
  @ApiResponse({
    status: 200,
    description: 'Job status retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            executionId: { type: 'string' },
            status: {
              type: 'string',
              enum: [
                'waiting',
                'active',
                'completed',
                'failed',
                'delayed',
                'paused',
              ],
            },
            progress: {
              type: 'number',
              description: 'Progress percentage (0-100)',
            },
            currentStep: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            processedAt: { type: 'string', format: 'date-time' },
            finishedAt: { type: 'string', format: 'date-time' },
            attempts: { type: 'number' },
            maxAttempts: { type: 'number' },
            failedReason: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Queue service not enabled or job not found',
  })
  async getJobStatus(
    @Query('jobId') jobId: string,
  ): Promise<{ success: boolean; data?: JobProgress; error?: string }> {
    this.logger.log(`Checking job status: ${jobId}`);

    try {
      if (!this.queueService) {
        throw new ServiceUnavailableException(
          'Queue service is not enabled. Async execution is not available.',
        );
      }

      if (!jobId) {
        throw new BadRequestException('Job ID is required');
      }

      const jobProgress = await this.queueService.getJobProgress(jobId);

      if (!jobProgress) {
        throw new BadRequestException(`Job not found: ${jobId}`);
      }

      return {
        success: true,
        data: jobProgress,
      };
    } catch (error) {
      this.logger.error(
        `Job status check failed: ${error.message}`,
        error.stack,
      );

      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Failed to retrieve job status: ${error.message}`,
      );
    }
  }

  /**
   * Get job result by job ID (for completed/failed async executions)
   */
  @Get('job-result/:jobId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get async job result with complete execution data',
    description: `
    Retrieve the final result of a completed or failed async swap job.
    
    This endpoint provides the SAME complete data as synchronous execution:
    • Full ExecutionData object in data.fullResult (currencies, route, transaction, addresses, etc.)
    • Transaction hash and output amount for quick access
    • Error details for failed swaps
    • Execution duration and timestamps
    • All tracking URLs and metadata
    
    The response structure matches the synchronous /execute endpoint, ensuring consistency
    between async and sync workflows.
    `,
  })
  @ApiQuery({
    name: 'jobId',
    required: true,
    type: String,
    description: 'Job ID returned from async execution request',
  })
  @ApiResponse({
    status: 200,
    description: 'Job result retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            executionId: { type: 'string' },
            success: { type: 'boolean' },
            data: {
              type: 'object',
              description:
                'Swap execution data (same structure as synchronous execution)',
              properties: {
                transactionHash: {
                  type: 'string',
                  description: 'Primary transaction hash',
                },
                outputAmount: {
                  type: 'string',
                  description: 'Output amount received',
                },
                swapType: {
                  type: 'string',
                  description: 'Type of swap executed',
                },
                provider: {
                  type: 'string',
                  description: 'Provider used for execution',
                },
                fullResult: {
                  type: 'object',
                  description:
                    'Complete ExecutionData object with all details (currencies, route, transaction, addresses, amountAdjustment, etc.). This matches the response structure of synchronous execution.',
                },
              },
            },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: { type: 'string' },
              },
            },
            startedAt: { type: 'string', format: 'date-time' },
            completedAt: { type: 'string', format: 'date-time' },
            duration: {
              type: 'number',
              description: 'Duration in milliseconds',
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Queue service not enabled or job not found',
  })
  async getJobResult(
    @Query('jobId') jobId: string,
  ): Promise<{ success: boolean; data?: JobResult; error?: string }> {
    this.logger.log(`Checking job result: ${jobId}`);

    try {
      if (!this.queueService) {
        throw new ServiceUnavailableException(
          'Queue service is not enabled. Async execution is not available.',
        );
      }

      if (!jobId) {
        throw new BadRequestException('Job ID is required');
      }

      const jobResult = await this.queueService.getJobResult(jobId);

      if (!jobResult) {
        throw new BadRequestException(
          `Job result not found: ${jobId}. Job may still be in progress or not exist.`,
        );
      }

      return {
        success: true,
        data: jobResult,
      };
    } catch (error) {
      this.logger.error(
        `Job result check failed: ${error.message}`,
        error.stack,
      );

      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Failed to retrieve job result: ${error.message}`,
      );
    }
  }

  /**
   * Get trace status by trace ID
   */
  @Get('trace-status/:traceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get workflow status by trace ID',
    description: `
    Retrieve the current workflow status and progress using trace ID.
    
    This endpoint provides:
    • Workflow status (pending, in_progress, completed, failed)
    • Current step progress with detailed status
    • Step-by-step execution timeline
    • Progress percentage and estimated completion
    • Execution result (when completed)
    • Error details (when failed)
    
    Use this endpoint to track async swap execution progress or review completed swap workflows.
    `,
  })
  @ApiResponse({
    status: 200,
    description: 'Trace status retrieved successfully',
    type: TraceStatusResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Trace not found',
  })
  async getTraceStatus(
    @Param('traceId') traceId: string,
  ): Promise<TraceStatusResponseDto> {
    this.logger.log(`Fetching trace status: ${traceId}`);

    try {
      const workflow = this.traceLogger.getWorkflowStatus(traceId);

      if (!workflow) {
        throw new BadRequestException(`Trace not found: ${traceId}`);
      }

      // Build workflow response
      const workflowResponse: WorkflowStatusResponseDto = {
        traceId: workflow.traceId,
        status: workflow.status,
        currentStep: workflow.currentStep,
        totalSteps: workflow.totalSteps,
        progressPercentage: Math.round(
          ((workflow.currentStep + 1) / workflow.totalSteps) * 100,
        ),
        steps: workflow.steps.map((step) => ({
          name: step.name,
          status: step.status,
          startTime: step.startTime?.toISOString(),
          endTime: step.endTime?.toISOString(),
          duration: step.duration,
          error: step.error,
          metadata: step.metadata,
        })),
        startTime: workflow.startTime.toISOString(),
        endTime: workflow.endTime?.toISOString(),
        duration: workflow.duration,
        metadata: workflow.metadata,
      };

      // Get execution result if completed (from state service)
      let executionResult: any = undefined;
      let executionError: any = undefined;

      if (workflow.metadata?.executionId) {
        const snapshot = await this.stateService.getExecutionSnapshot(
          workflow.metadata.executionId,
        );
        if (snapshot) {
          if (snapshot.overall === 'SUCCESS' || snapshot.overall === 'IN_PROGRESS') {
            executionResult = snapshot;
          } else if (snapshot.overall === 'FAILED') {
            executionError = {
              code: 'EXECUTION_FAILED',
              message: 'Swap execution failed',
              details: snapshot,
            };
          }
        }
      }

      const response: TraceStatusResponseDto = {
        success: true,
        traceId,
        workflow: workflowResponse,
        result: executionResult,
        error: executionError,
        timestamp: new Date().toISOString(),
      };

      return response;
    } catch (error) {
      this.logger.error(
        `Trace status check failed: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Failed to retrieve trace status: ${error.message}`,
      );
    }
  }

  /**
   * Get trace logs by trace ID
   */
  @Get('trace-logs/:traceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get hierarchical logs by trace ID',
    description: `
    Retrieve all logs for a trace with parent-child hierarchical structure.
    
    This endpoint provides:
    • Complete log history for the trace
    • Hierarchical parent-child log relationships
    • Log tree for visualization (e.g., in UI tree components)
    • Structured metadata for analytics (Loki, Elasticsearch, etc.)
    • Operation durations and timestamps
    
    Perfect for debugging, auditing, and analyzing swap execution flow.
    `,
  })
  @ApiResponse({
    status: 200,
    description: 'Trace logs retrieved successfully',
    type: TraceLogsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Trace not found',
  })
  async getTraceLogs(
    @Param('traceId') traceId: string,
  ): Promise<TraceLogsResponseDto> {
    this.logger.log(`Fetching trace logs: ${traceId}`);

    try {
      const logs = this.traceLogger.getTraceLogs(traceId);
      const logTree = this.traceLogger.buildLogTree(traceId);

      if (logs.length === 0) {
        throw new BadRequestException(
          `No logs found for trace: ${traceId}. Trace may not exist or logs may have been cleared.`,
        );
      }

      const response: TraceLogsResponseDto = {
        success: true,
        traceId,
        totalLogs: logs.length,
        logs: logs.map((log) => ({
          logId: log.logId,
          traceId: log.traceId,
          parentLogId: log.parentLogId,
          level: log.level,
          message: log.message,
          context: log.context,
          timestamp: log.timestamp,
          duration: log.duration,
          metadata: log.metadata,
          step: log.step,
        })),
        logTree,
        timestamp: new Date().toISOString(),
      };

      return response;
    } catch (error) {
      this.logger.error(
        `Trace logs check failed: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Failed to retrieve trace logs: ${error.message}`,
      );
    }
  }

  // Dead code removed: routeToProviderManager
  // Routing logic is now handled by SwapOrchestrationService

  /**
   * Handle Solana router routing (Rubic)
   * Implements intelligent routing with primary/fallback provider strategy
   */
  private async handleSolanaRouters(request: UniversalSwapRequestDto) {
    this.logger.debug('Processing Solana router request');

    try {
      // Critical Path 1: Validate Solana ecosystem
      if (
        request.sellToken.chain.ecosystem !== BlockchainEcosystem.SOLANA ||
        request.buyToken.chain.ecosystem !== BlockchainEcosystem.SOLANA
      ) {
        throw new Error(
          `Solana routers can only handle Solana ecosystem swaps. ` +
            `Got: ${request.sellToken.chain.ecosystem} -> ${request.buyToken.chain.ecosystem}`,
        );
      }

      // Critical Path 2: Validate same-chain swap (Solana routers don't handle cross-chain)
      const sellChainId = String(request.sellToken.chain.chainId);
      const buyChainId = String(request.buyToken.chain.chainId);

      if (sellChainId !== buyChainId) {
        this.logger.warn(
          `Cross-chain Solana swap detected (${sellChainId} -> ${buyChainId}), ` +
            `routing to meta aggregators instead`,
        );
        // Fall back to meta aggregators for cross-chain Solana swaps
        return await this.handleMetaAggregators(request);
      }

      // Critical Path 3: Validate token addresses are present
      if (!request.sellToken.address) {
        throw new Error(
          `Sell token address (mint) is required for Solana swaps. ` +
            `Token: ${request.sellToken.symbol} on chain ${sellChainId}`,
        );
      }

      if (!request.buyToken.address) {
        throw new Error(
          `Buy token address (mint) is required for Solana swaps. ` +
            `Token: ${request.buyToken.symbol} on chain ${buyChainId}`,
        );
      }

      // Critical Path 4: Validate wallet address format (Solana public key)
      if (!request.taker || request.taker.length < 32) {
        throw new Error(
          `Valid Solana wallet address (public key) is required. ` +
            `Provided: ${request.taker}`,
        );
      }

      // Build Solana quote request following Rubic API standards
      const solanaQuoteRequest = {
        fromMint: request.sellToken.address,
        toMint: request.buyToken.address,
        amount: request.sellAmount,
        slippageBps: request.slippageToleranceBps ?? 300, // Default 3% slippage
        userPublicKey: request.taker,
        // Add chainId for Rubic fallback compatibility
        fromChainId: sellChainId,
        toChainId: buyChainId,
        // Optional parameters for better routing
        platformFeeBps: 0, // No platform fee by default
      };

      this.logger.debug(`Solana quote request:`, {
        fromMint: solanaQuoteRequest.fromMint.substring(0, 8) + '...',
        toMint: solanaQuoteRequest.toMint.substring(0, 8) + '...',
        amount: solanaQuoteRequest.amount,
        slippageBps: solanaQuoteRequest.slippageBps,
        preferredProvider: request.preferredProvider,
      });

      // Critical Path 5: Get quote from Solana router using priority strategy
      // Rubic is the only Solana provider available
      let quote: any;
      let providerUsed: string;

      try {
        quote = await this.aggregatorManager.getSolanaQuote(
          solanaQuoteRequest,
          request.preferredProvider,
        );

        // Determine which provider was actually used
        providerUsed = request.preferredProvider || 'rubic'; // Rubic is primary per routing strategy

        this.logger.debug(
          `Received Solana quote from ${providerUsed}: ` +
            `${quote.totalEstimatedOut} output, ETA ${quote.etaSeconds}s`,
        );
      } catch (primaryError) {
        this.logger.error(
          `Primary Solana router failed: ${primaryError.message}`,
          primaryError.stack,
        );

        // Critical Path 6: No fallback available - Rubic is the only Solana provider
        this.logger.error(`Solana router failed: ${primaryError.message}`);
        throw new Error(
          `Solana swap failed. Rubic is the only provider available. ` +
            `Error: ${primaryError.message}`,
        );
      }

      // Critical Path 7: Validate quote response integrity
      if (
        !quote ||
        !quote.totalEstimatedOut ||
        quote.totalEstimatedOut === '0'
      ) {
        throw new Error(
          `Invalid Solana quote received: ${JSON.stringify(quote)}. ` +
            `Provider may not support this token pair or liquidity is insufficient.`,
        );
      }

      // Critical Path 8: Convert to universal route format
      const route = {
        provider: providerUsed,
        outputAmount: quote.totalEstimatedOut,
        estimatedGas: quote.fees?.gas || '5000', // Solana typical SOL fee (~5000 lamports)
        steps: this.buildSolanaRouteSteps(quote, request),
        estimatedTime: quote.etaSeconds || 30, // Typical Solana confirmation time
        qualityScore: this.calculateSolanaQualityScore(quote, providerUsed),
        routeId: quote.routeId,
        providerRef: quote.providerRef || quote, // Attach provider-specific reference for executor
        // Include Solana-specific metadata
        metadata: {
          provider: providerUsed,
          priceImpact: quote.priceImpact,
          fees: quote.fees,
          confidence: quote.confidence,
          // Solana-specific fields
          computeUnits: quote.providerRef?.computeUnits,
          priorityFee: quote.providerRef?.priorityFee,
          slippageBps: solanaQuoteRequest.slippageBps,
          originalQuote: quote,
        },
      };

      // Critical Path 9: Log successful route generation
      this.logger.log(
        `✅ Generated Solana route via ${providerUsed}: ` +
          `Quality score ${route.qualityScore}, ` +
          `${route.steps.length} steps, ` +
          `ETA ${route.estimatedTime}s`,
      );

      return [route];
    } catch (error) {
      this.logger.error(
        `Solana router routing failed: ${error.message}`,
        error.stack,
      );

      // Critical Path 10: Return descriptive error fallback
      return [
        {
          provider: 'solana-error',
          outputAmount: '0',
          estimatedGas: '0',
          steps: [],
          estimatedTime: 0,
          qualityScore: 0,
          error: `Solana swap failed: ${error.message}`,
          metadata: {
            errorDetails: {
              message: error.message,
              stack: error.stack,
              sellToken: request.sellToken.symbol,
              buyToken: request.buyToken.symbol,
              chainId: request.sellToken.chain.chainId,
            },
          },
        },
      ];
    }
  }

  /**
   * Build Solana route steps from quote response
   * Handles both direct swaps and multi-hop routes
   */
  private buildSolanaRouteSteps(
    quote: any,
    request: UniversalSwapRequestDto,
  ): any[] {
    const steps = quote.steps || [];

    // If no steps provided, create a single direct swap step
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
          // Solana-specific step metadata
          dex: quote.providerRef?.dex,
          marketId: quote.providerRef?.marketId,
        },
      ];
    }

    // Map multi-hop steps to universal format
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
      // Solana-specific step metadata
      dex: step.dex,
      marketId: step.marketId,
      fee: step.fee,
    }));
  }

  /**
   * Calculate quality score for Solana routes
   * Higher score = better route quality
   */
  private calculateSolanaQualityScore(quote: any, provider: string): number {
    let score = 100; // Base score

    // Factor 1: Provider reliability bonus
    if (provider.toLowerCase() === 'rubic') {
      score += 10; // Rubic primary provider bonus
    } else if (provider.toLowerCase() === 'jupiter') {
      score += 8; // Jupiter is reputable but secondary
    }

    // Factor 2: Price impact penalty
    if (quote.priceImpact) {
      const priceImpact = parseFloat(quote.priceImpact);
      if (priceImpact < 0.5) {
        score += 5; // Very low price impact bonus
      } else if (priceImpact > 2) {
        score -= 15; // High price impact penalty
      } else if (priceImpact > 5) {
        score -= 30; // Very high price impact severe penalty
      }
    }

    // Factor 3: Confidence score (if provided by aggregator)
    if (quote.confidence) {
      const confidenceBonus = Math.round((quote.confidence - 0.5) * 20);
      score += confidenceBonus; // -10 to +10 based on confidence
    }

    // Factor 4: Route complexity penalty
    const steps = quote.steps?.length || 1;
    if (steps === 1) {
      score += 5; // Direct swap bonus
    } else if (steps > 3) {
      score -= (steps - 3) * 5; // Multi-hop penalty
    }

    // Factor 5: Estimated time bonus/penalty
    const etaSeconds = quote.etaSeconds || 30;
    if (etaSeconds < 20) {
      score += 3; // Fast execution bonus
    } else if (etaSeconds > 60) {
      score -= 5; // Slow execution penalty
    }

    // Factor 6: Fee efficiency
    if (quote.fees?.gas) {
      const gasLamports = parseFloat(quote.fees.gas);
      if (gasLamports < 3000) {
        score += 3; // Low fee bonus
      } else if (gasLamports > 10000) {
        score -= 5; // High fee penalty
      }
    }

    // Ensure score is within valid range [0, 100]
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Handle EVM aggregator routing with dynamic provider selection
   */
  private async handleEvmAggregators(
    request: UniversalSwapRequestDto,
    swapType: SwapType,
  ) {
    this.logger.debug('Processing EVM aggregator request');

    try {
      // Convert universal request to legacy format parameters
      const legacyParams = this.convertToLegacyParams(request);

      this.logger.debug(
        `EVM params: Chain ${legacyParams.chainId}, ${legacyParams.sellToken} -> ${legacyParams.buyToken}, Amount: ${legacyParams.sellAmount}`,
      );

      // Get multiple quotes using the existing dynamic provider selection
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

      this.logger.debug(
        `Received ${quotes.length} quotes from EVM aggregators`,
      );

      // Convert quotes to universal route format
      const routes = quotes.map((quoteResult, index) => {
        const { aggregator, quote } = quoteResult;

        this.logger.debug(
          `Processing quote ${index + 1} from ${aggregator}: ${quote.buyAmount} output, ${quote.gas} gas`,
        );

        // Build a Step object compatible with executor factory expectations
        const step = {
          // Executor-required fields
          kind: 'swap' as const,
          chainId: legacyParams.chainId,
          details: {
            provider: aggregator,
            fromToken: quote.sellToken,
            toToken: quote.buyToken,
            fromChain: legacyParams.chainId.toString(),
            toChain: legacyParams.chainId.toString(),
            estimatedTime: 30,
          },
          // Response/legacy-compatible fields
          action: 'swap' as const,
          provider: String(aggregator),
          fromToken: quote.sellToken,
          toToken: quote.buyToken,
          fromChain: legacyParams.chainId.toString(),
          toChain: legacyParams.chainId.toString(),
          estimatedTime: 30,
        } as any;

        return {
          provider: aggregator,
          outputAmount: quote.buyAmount,
          estimatedGas: quote.estimatedGas || quote.gas,
          steps: [step],
          estimatedTime: 30,
          qualityScore: this.calculateRouteQualityScore(
            quote,
            index,
            aggregator,
          ),
          // Include transaction data for immediate execution
          transactionData: {
            to: quote.to,
            data: quote.data,
            value: quote.value,
            gasLimit: quote.estimatedGas || quote.gas,
            gasPrice: quote.gasPrice,
            maxFeePerGas: quote.maxFeePerGas,
            maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
            allowanceTarget: quote.allowanceTarget,
          },
          // Attach providerRef for executors (full SwapQuote)
          providerRef: quote,
          // Include additional metadata
          metadata: {
            aggregator: aggregator,
            priceImpact: quote.priceImpact,
            minBuyAmount: quote.minBuyAmount,
            approvalStrategy: quote.approvalStrategy,
            chainId: legacyParams.chainId,
            originalQuote: quote,
          },
        };
      });

      // Sort by quality score (highest first)
      routes.sort((a, b) => b.qualityScore - a.qualityScore);

      // Cache successful quotes for future chain/token support checks
      if (routes.length > 0 && routes[0].qualityScore > 0) {
        this.swapRoutingService.cacheSupportedQuote(
          legacyParams.chainId,
          legacyParams.buyToken,
          legacyParams.sellToken,
        );
      }

      this.logger.log(
        `✅ Generated ${routes.length} EVM routes with quality scores: ${routes.map((r) => `${r.provider}:${r.qualityScore}`).join(', ')}`,
      );

      return routes;
    } catch (error) {
      this.logger.error(
        `EVM aggregator routing failed: ${error.message}`,
        error.stack,
      );

      // Return fallback route with error indication
      return [
        {
          provider: 'evm-fallback',
          outputAmount: '0',
          estimatedGas: '0',
          steps: [],
          estimatedTime: 0,
          qualityScore: 0,
          error: error.message,
        },
      ];
    }
  }

  /**
   * Handle Meta aggregator routing with AggregatorManager
   */
  private async handleMetaAggregators(request: UniversalSwapRequestDto) {
    this.logger.debug('Processing meta aggregator request');

    // Validate addresses are present
    if (!request.sellToken.address) {
      throw new Error(
        'Sell token address is required for meta aggregator routing',
      );
    }

    if (!request.buyToken.address) {
      throw new Error(
        'Buy token address is required for meta aggregator routing',
      );
    }

    const routeReq = {
      fromChainId: request.sellToken.chain.chainId as number,
      toChainId: request.buyToken.chain.chainId as number,
      fromToken: request.sellToken.address,
      toToken: request.buyToken.address,
      amount: request.sellAmount,
      slippageBps: request.slippageToleranceBps ?? 300,
      userAddress: request.taker,
      recipient: request.recipient,
      referrer: request.preferredProvider,
    };

    const routes = await this.aggregatorManager.getCrossChainRoutes(routeReq);

    // Map to universal route format with executor-compatible steps
    const mapped = routes.map((r) => ({
      provider: 'meta',
      outputAmount: r.totalEstimatedOut,
      minOutputAmount:
        r.minOutputAmount || r.providerRef?.minBuyAmount || undefined,
      estimatedGas: r.fees?.gas || '0',
      steps: (r.steps || []).map((s) => ({
        // Executor-required fields
        kind:
          s.kind ||
          (routeReq.fromChainId === routeReq.toChainId
            ? ('swap' as const)
            : ('bridge' as const)),
        chainId: s.chainId || routeReq.fromChainId,
        details: {
          provider: s.protocol || 'unknown',
          fromToken: request.sellToken.address!,
          toToken: request.buyToken.address!,
          fromChain: String(s.chainId || routeReq.fromChainId),
          toChain: String(routeReq.toChainId),
          estimatedTime: s.estimatedTime || r.etaSeconds || 0,
        },
        // Response/legacy-compatible fields
        action: s.kind === 'bridge' ? ('bridge' as const) : ('swap' as const),
        provider: s.protocol || 'unknown',
        fromToken: request.sellToken.address!,
        toToken: request.buyToken.address!,
        fromChain: (s.chainId || routeReq.fromChainId).toString(),
        toChain: routeReq.toChainId.toString(),
        estimatedTime: s.estimatedTime || r.etaSeconds || 0,
      })),
      estimatedTime: r.etaSeconds || 0,
      qualityScore: Math.round((r.confidence ?? 0.8) * 100),
      routeId: r.routeId,
      providerRef: r.providerRef || r,
      metadata: {
        bridge: r.fees?.bridge,
        providerGas: r.fees?.gas,
        // Enhanced fee details
        gasCostWei: r.fees?.gasCostWei,
        gasPrice: r.fees?.gasPrice,
        maxFeePerGas: r.fees?.maxFeePerGas,
        maxPriorityFeePerGas: r.fees?.maxPriorityFeePerGas,
        percentFeePercent: r.fees?.percentFeePercent,
        percentFeeToken: r.fees?.percentFeeToken,
        // Enhanced estimate details
        priceImpact: r.priceImpact,
        slippage: r.providerRef?.slippage,
        minOutputAmount: r.minOutputAmount,
        destinationWeiAmount: r.providerRef?.destinationWeiAmount,
        destinationTokenAmount: r.providerRef?.destinationTokenAmount,
        confidence: r.confidence,
        originalRoute: r,
      },
    }));

    mapped.sort((a, b) => b.qualityScore - a.qualityScore);
    return mapped;
  }

  /**
   * Convert UniversalSwapRequestDto to legacy parameters format
   */
  private convertToLegacyParams(request: UniversalSwapRequestDto) {
    // Validate that this is an EVM request
    if (
      request.sellToken.chain.ecosystem !== 'evm' ||
      request.buyToken.chain.ecosystem !== 'evm'
    ) {
      throw new Error('EVM aggregators can only handle EVM ecosystem requests');
    }

    if (request.sellToken.chain.chainId !== request.buyToken.chain.chainId) {
      throw new Error('EVM aggregators can only handle same-chain swaps');
    }

    // Validate addresses are present (should be enriched before calling this)
    if (!request.sellToken.address) {
      throw new Error('Sell token address is required for EVM swaps');
    }

    if (!request.buyToken.address) {
      throw new Error('Buy token address is required for EVM swaps');
    }

    const chainId = request.sellToken.chain.chainId as number;

    return {
      chainId,
      sellToken: request.sellToken.address,
      buyToken: request.buyToken.address,
      sellAmount: request.sellAmount,
      taker: request.taker,
      recipient: request.recipient,
      slippagePercentage: request.slippageToleranceBps
        ? request.slippageToleranceBps / 100
        : undefined,
      deadline: request.deadline,
    };
  }

  /**
   * Calculate route quality score based on quote characteristics
   */
  private calculateRouteQualityScore(
    quote: any,
    index: number,
    aggregator: string,
  ): number {
    let score = 100; // Base score

    // Penalize based on position (first quote is usually best)
    score -= index * 5;

    // Bonus for higher output amount (better price)
    const outputAmount = parseFloat(quote.buyAmount);
    if (outputAmount > 0) {
      score += Math.min(10, outputAmount / 1000000); // Small bonus for larger amounts
    }

    // Bonus for lower gas costs
    const gasAmount = parseFloat(quote.estimatedGas || quote.gas || '0');
    if (gasAmount > 0) {
      score -= Math.min(20, gasAmount / 100000); // Penalty for high gas
    }

    // Bonus for specific providers based on reliability
    switch (aggregator) {
      case '0x':
        score += 10; // Reliable provider bonus
        break;
      case 'odos':
        score += 8; // Good provider bonus
        break;
      default:
        score += 5; // Default provider bonus
    }

    // Bonus for price impact if available
    if (quote.priceImpact) {
      const priceImpact = parseFloat(quote.priceImpact);
      if (priceImpact < 1) {
        score += 5; // Low price impact bonus
      } else if (priceImpact > 5) {
        score -= 10; // High price impact penalty
      }
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // Dead code removed: generateWarnings
  // Warning generation is now handled by SwapOrchestrationService

  /**
   * Provider-specific liquidity check with quote data caching
   */
  private async checkLiquidityByProviderWithCache(
    providerCategory: string | null,
    request: UniversalSwapRequestDto,
    warnings: string[],
  ): Promise<{ hasLiquidity: boolean; quoteData: any }> {
    if (!providerCategory) {
      warnings.push(
        'Provider category could not be determined - liquidity check skipped',
      );
      return { hasLiquidity: false, quoteData: null };
    }

    switch (providerCategory) {
      case 'evm-aggregators':
        return this.checkEvmLiquidityWithCache(request, warnings);

      case 'meta':
        return this.checkMetaLiquidityWithCache(request, warnings);

      case 'solana':
        return this.checkSolanaLiquidityWithCache(request, warnings);

      default:
        warnings.push(
          `Unknown provider category '${providerCategory}' - liquidity check skipped`,
        );
        return { hasLiquidity: false, quoteData: null };
    }
  }

  /**
   * EVM aggregator liquidity check with quote data caching
   */
  private async checkEvmLiquidityWithCache(
    request: UniversalSwapRequestDto,
    warnings: string[],
  ): Promise<{ hasLiquidity: boolean; quoteData: any }> {
    try {
      const legacyParams = this.convertToLegacyParams(request);
      this.logger.debug(
        `Performing EVM liquidity check: ${legacyParams.sellToken} -> ${legacyParams.buyToken}`,
      );

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

      const hasLiquidity =
        quotes.length > 0 && parseFloat(quotes[0].quote.buyAmount) > 0;

      if (!hasLiquidity) {
        warnings.push('No liquidity available for requested EVM swap');
      } else {
        // Cache successful quote for future support checks
        this.swapRoutingService.cacheSupportedQuote(
          legacyParams.chainId,
          legacyParams.buyToken,
          legacyParams.sellToken,
        );
      }

      // Return both liquidity status and cached quote data for approval checks
      return {
        hasLiquidity,
        quoteData: {
          quotes,
          type: 'evm-quotes',
          params: legacyParams,
        },
      };
    } catch (error) {
      warnings.push(`EVM liquidity check failed: ${error.message}`);
      return { hasLiquidity: false, quoteData: null };
    }
  }

  /**
   * Meta aggregator liquidity check with quote data caching
   */
  private async checkMetaLiquidityWithCache(
    request: UniversalSwapRequestDto,
    warnings: string[],
  ): Promise<{ hasLiquidity: boolean; quoteData: any }> {
    try {
      // For meta aggregators, we can try to get cross-chain routes
      const routeReq = {
        fromChainId: request.sellToken.chain.chainId as number,
        toChainId: request.buyToken.chain.chainId as number,
        fromToken: request.sellToken.address || 'ETH',
        toToken: request.buyToken.address || 'ETH',
        amount: request.sellAmount,
        slippageBps: request.slippageToleranceBps ?? 300,
        userAddress: request.taker,
        recipient: request.recipient,
      };

      const routes = await this.aggregatorManager.getCrossChainRoutes(routeReq);
      const hasLiquidity = routes.length > 0;

      if (!hasLiquidity) {
        warnings.push('No cross-chain routes available for requested swap');
      }

      // Return both liquidity status and cached route data for approval checks
      return {
        hasLiquidity,
        quoteData: {
          routes,
          type: 'meta-routes',
          params: routeReq,
        },
      };
    } catch (error) {
      warnings.push(`Meta aggregator liquidity check failed: ${error.message}`);
      return { hasLiquidity: false, quoteData: null };
    }
  }

  /**
   * Solana liquidity check with quote data caching
   */
  private async checkSolanaLiquidityWithCache(
    request: UniversalSwapRequestDto,
    warnings: string[],
  ): Promise<{ hasLiquidity: boolean; quoteData: any }> {
    try {
      // Build Solana quote request
      const solanaQuoteRequest = {
        fromMint: request.sellToken.address,
        toMint: request.buyToken.address,
        amount: request.sellAmount,
        slippageBps: request.slippageToleranceBps ?? 300,
        userPublicKey: request.taker,
      };

      this.logger.debug(
        `Performing Solana liquidity check: ${request.sellToken.symbol} -> ${request.buyToken.symbol}`,
      );

      // Get quote via Solana-capable meta aggregator (Rubic)
      const quote = await this.aggregatorManager.getSolanaQuote(
        solanaQuoteRequest,
        request.preferredProvider,
      );

      const hasLiquidity = parseFloat(quote.totalEstimatedOut || '0') > 0;

      if (!hasLiquidity) {
        warnings.push('No Solana liquidity available for requested swap');
      } else {
        this.logger.debug(
          `✅ Solana liquidity confirmed: ${quote.totalEstimatedOut} ${request.buyToken.symbol}`,
        );
      }

      // Return both liquidity status and cached quote data for approval checks
      return {
        hasLiquidity,
        quoteData: {
          quote,
          type: 'solana-quote',
          params: solanaQuoteRequest,
        },
      };
    } catch (error) {
      warnings.push(`Solana liquidity check failed: ${error.message}`);
      this.logger.error(
        `Solana liquidity check error: ${error.message}`,
        error.stack,
      );
      return { hasLiquidity: false, quoteData: null };
    }
  }

  /**
   * Ecosystem-specific approval check
   */
  private async checkApprovalByEcosystem(
    request: UniversalSwapRequestDto,
    providerCategory: string | null,
    warnings: string[],
    details: Record<string, any>,
    cachedQuoteData?: any,
  ): Promise<boolean> {
    switch (request.sellToken.chain.ecosystem) {
      case 'evm':
        return this.checkEvmApproval(
          request,
          warnings,
          details,
          cachedQuoteData,
        );

      case 'solana':
        // Solana uses account-based model, no approvals needed
        details.approvalNote =
          'Solana ecosystem does not require token approvals';
        return false;

      case 'bitcoin':
      case 'cardano':
      case 'substrate':
        // Native L1 chains don't use smart contract approvals
        details.approvalNote = `${request.sellToken.chain.ecosystem} ecosystem uses native transactions - no approvals needed`;
        return false;

      default:
        warnings.push(
          `Approval check not implemented for ecosystem: ${request.sellToken.chain.ecosystem}`,
        );
        details.approvalNote = `Approval logic not implemented for ${request.sellToken.chain.ecosystem} ecosystem`;
        return false;
    }
  }

  /**
   * EVM-specific approval check
   */
  private async checkEvmApproval(
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
    cachedQuoteData?: any,
  ): Promise<boolean> {
    if (!request.sellToken.address) {
      warnings.push('EVM token address not available - approval check skipped');
      details.approvalNote = 'Token address not available for approval check';
      return false;
    }

    // Check for native ETH - no approval needed
    const isNativeEth =
      request.sellToken.address.toLowerCase() ===
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    if (isNativeEth) {
      details.approvalNote = 'Native ETH does not require approval';
      return false;
    }

    try {
      let spender: string | null = null;

      // Try to extract spender from cached quote data first (more efficient)
      if (cachedQuoteData) {
        if (
          cachedQuoteData.type === 'evm-quotes' &&
          cachedQuoteData.quotes?.length > 0
        ) {
          // For EVM aggregator quotes
          const firstQuote = cachedQuoteData.quotes[0];
          if (firstQuote.quote?.allowanceTarget) {
            spender = firstQuote.quote.allowanceTarget;
            this.logger.debug(
              `Using spender from cached EVM quote data: ${spender || 'null'}`,
            );
          }
        } else if (
          cachedQuoteData.type === 'meta-routes' &&
          cachedQuoteData.routes?.length > 0
        ) {
          // For meta aggregator routes (cross-chain)
          const firstRoute = cachedQuoteData.routes[0];
          if (firstRoute.providerRef?.approvalAddress) {
            spender = firstRoute.providerRef.approvalAddress;
            this.logger.debug(
              `Using spender from cached meta route providerRef: ${spender || 'null'}`,
            );
          } else if (
            firstRoute.approvalAddress ||
            firstRoute.spenderAddress ||
            firstRoute.allowanceTarget
          ) {
            spender =
              firstRoute.approvalAddress ||
              firstRoute.spenderAddress ||
              firstRoute.allowanceTarget;
            this.logger.debug(
              `Using spender from cached meta route data: ${spender || 'null'}`,
            );
          }
        }
      }

      // Fallback: fetch spender via SwapRoutingService if not available in cache
      if (!spender) {
        this.logger.debug(
          'Cached spender not available, fetching via SwapRoutingService',
        );
        spender = await this.swapRoutingService.getSpenderForSwap(
          request,
          this.aggregatorManager,
        );
      }

      if (!spender) {
        warnings.push('Could not determine spender address for approval check');
        details.approvalNote = 'Spender address could not be determined';
        return false;
      }

      const sellTokenDecimals = request.sellToken.decimals || 18;
      const normalizedAmount = this.amountUtils.normalizeAmount(
        request.sellAmount,
        sellTokenDecimals,
        ProviderAmountFormat.WEI,
      );

      // Get chainId - keep as-is (can be number or string)
      const chainId = request.sellToken.chain.chainId;

      // Only call getApprovalStatus if chainId is numeric (EVM chains)
      // Non-EVM chains like 'solana-mainnet' don't use ERC20 approvals
      if (typeof chainId === 'string' && isNaN(Number(chainId))) {
        // Non-EVM chain - no approval needed
        details.approvalNote = `Non-EVM chain (${chainId}) - no approval required`;
        return false;
      }

      const approvalStatus = await this.approvalService.getApprovalStatus(
        typeof chainId === 'string' ? parseInt(chainId) : chainId,
        request.sellToken.address,
        request.taker,
        spender,
        normalizedAmount,
      );

      if (approvalStatus.isApprovalNeeded) {
        warnings.push('Token approval required for swap');
      }

      details.approvalDetails = {
        spenderAddress: spender,
        normalizedAmount: normalizedAmount,
        decimalsUsed: sellTokenDecimals,
        currentAllowance: approvalStatus.currentAllowance || '0',
        spenderSource: cachedQuoteData
          ? `cached-${cachedQuoteData.type}`
          : 'routing-service',
      };

      return approvalStatus.isApprovalNeeded;
    } catch (error) {
      warnings.push(`EVM approval check failed: ${error.message}`);
      details.approvalNote = `Approval check failed: ${error.message}`;
      return false;
    }
  }

  /**
   * Ecosystem-specific balance check
   */
  private async checkBalanceByEcosystem(
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
  ): Promise<boolean> {
    switch (request.sellToken.chain.ecosystem) {
      case 'evm':
        return this.checkEvmBalance(request, warnings, details);

      case 'solana':
        return this.checkSolanaBalance(request, warnings, details);

      case 'bitcoin':
        return this.checkBitcoinBalance(request, warnings, details);

      case 'cardano':
        return this.checkCardanoBalance(request, warnings, details);

      case 'substrate':
        return this.checkSubstrateBalance(request, warnings, details);

      default:
        warnings.push(
          `Balance check not implemented for ecosystem: ${request.sellToken.chain.ecosystem}`,
        );
        details.balanceNote = `Balance check not implemented for ${request.sellToken.chain.ecosystem}`;
        return true; // Optimistic - allow swap to proceed
    }
  }

  /**
   * EVM-specific balance check
   */
  private async checkEvmBalance(
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
  ): Promise<boolean> {
    if (!request.sellToken.address) {
      warnings.push('EVM token address not available - balance check skipped');
      details.balanceNote = 'Token address not available for balance check';
      return true;
    }

    try {
      // Get chainId - keep as-is (can be number or string)
      const chainId = request.sellToken.chain.chainId;

      // Only call getBalance if chainId is numeric (EVM chains)
      // Non-EVM chains like 'solana-mainnet' need different balance checking
      if (typeof chainId === 'string' && isNaN(Number(chainId))) {
        // Non-EVM chain - skip EVM balance check
        details.balanceNote = `Non-EVM chain (${chainId}) - EVM balance check skipped`;
        return true;
      }

      const balanceInfo = await this.walletService.getBalance(
        typeof chainId === 'string' ? parseInt(chainId) : chainId,
        request.taker,
        request.sellToken.address,
      );

      const sellTokenDecimals = request.sellToken.decimals || 18;
      const normalizedAmount = this.amountUtils.normalizeAmount(
        request.sellAmount,
        sellTokenDecimals,
        ProviderAmountFormat.WEI,
      );

      const balanceBigInt = BigInt(balanceInfo.balance);
      const requiredAmount = BigInt(normalizedAmount);
      const sufficientBalance = balanceBigInt >= requiredAmount;

      if (!sufficientBalance) {
        warnings.push('Insufficient wallet balance for swap');
        details.balanceDetails = {
          required: normalizedAmount,
          available: balanceInfo.balance,
          token: balanceInfo.symbol,
          requiredFormatted: `${request.sellAmount} (input)`,
          normalizedRequired: normalizedAmount,
          decimalsUsed: sellTokenDecimals,
        };
      }

      return sufficientBalance;
    } catch (error) {
      warnings.push(`EVM balance check failed: ${error.message}`);
      details.balanceNote = `Balance check failed: ${error.message}`;
      return false;
    }
  }

  /**
   * Solana-specific balance check
   */
  private async checkSolanaBalance(
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
  ): Promise<boolean> {
    try {
      // Get Solana wallet provider
      const provider = this.walletService.getWalletProvider('solana');
      if (!provider) {
        warnings.push(
          'Solana wallet provider not available - balance check skipped',
        );
        details.balanceNote = 'Solana wallet provider not configured';
        return true; // Optimistic - allow swap to proceed
      }

      // Fetch balance for Solana token
      const balanceInfo = await this.walletService.getBalance(
        request.sellToken.chain.chainId,
        request.taker,
        request.sellToken.address,
        'solana',
      );

      const sellTokenDecimals = request.sellToken.decimals || 9; // Solana default is 9 decimals
      const normalizedAmount = this.amountUtils.normalizeAmount(
        request.sellAmount,
        sellTokenDecimals,
        ProviderAmountFormat.WEI,
      );

      const balanceLamports = BigInt(balanceInfo.balance);
      const requiredLamports = BigInt(normalizedAmount);
      const sufficientBalance = balanceLamports >= requiredLamports;

      if (!sufficientBalance) {
        warnings.push('Insufficient Solana wallet balance for swap');
        details.balanceDetails = {
          required: normalizedAmount,
          available: balanceInfo.balance,
          token: balanceInfo.symbol || request.sellToken.symbol,
          requiredFormatted: `${request.sellAmount} (input)`,
          normalizedRequired: normalizedAmount,
          decimalsUsed: sellTokenDecimals,
        };
      } else {
        this.logger.debug(
          `✅ Solana balance sufficient: ${balanceInfo.balance} lamports (${balanceInfo.symbol})`,
        );
      }

      return sufficientBalance;
    } catch (error) {
      warnings.push(`Solana balance check failed: ${error.message}`);
      details.balanceNote = `Solana balance check failed: ${error.message}`;
      this.logger.error(
        `Solana balance check error: ${error.message}`,
        error.stack,
      );
      return false; // Conservative - deny swap if balance check fails
    }
  }

  /**
   * Bitcoin-specific balance check
   * Supports Bitcoin mainnet and testnet using UTXO model
   */
  private async checkBitcoinBalance(
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
  ): Promise<boolean> {
    try {
      // Get Bitcoin wallet provider
      const provider = this.walletService.getWalletProvider('bitcoin');
      if (!provider) {
        warnings.push(
          'Bitcoin wallet provider not available - balance check skipped',
        );
        details.balanceNote = 'Bitcoin wallet provider not configured';
        return true; // Optimistic - allow swap to proceed
      }

      // Fetch balance for Bitcoin address
      // Bitcoin uses 'native' or omit tokenAddress for BTC balance
      const balanceInfo = await this.walletService.getBalance(
        request.sellToken.chain.chainId,
        request.taker,
        'native', // Bitcoin doesn't have token contracts
        'bitcoin',
      );
      this.logger.debug(
        `Bitcoin balance retrieved - Balance: ${balanceInfo.balance}, Formatted: ${balanceInfo.formattedBalance}, Address: ${request.taker || 'N/A'}`,
      );

      const sellTokenDecimals = request.sellToken.decimals || 8; // Bitcoin has 8 decimal places (satoshis)
      const normalizedAmount = this.amountUtils.normalizeAmount(
        request.sellAmount,
        sellTokenDecimals,
        ProviderAmountFormat.WEI, // Actually satoshis for Bitcoin
      );

      const balanceSatoshis = BigInt(balanceInfo.balance);
      const requiredSatoshis = BigInt(normalizedAmount);
      const sufficientBalance = balanceSatoshis >= requiredSatoshis;

      if (!sufficientBalance) {
        warnings.push('Insufficient Bitcoin wallet balance for swap');
        details.balanceDetails = {
          required: normalizedAmount,
          available: balanceInfo.balance,
          token: balanceInfo.symbol || 'BTC',
          requiredFormatted: `${request.sellAmount} (input)`,
          normalizedRequired: normalizedAmount,
          decimalsUsed: sellTokenDecimals,
          note: 'Bitcoin balance in satoshis (1 BTC = 100,000,000 satoshis)',
        };
      } else {
        this.logger.debug(
          `✅ Bitcoin balance sufficient: ${balanceInfo.balance} satoshis (${balanceInfo.formattedBalance} BTC)`,
        );
      }

      return sufficientBalance;
    } catch (error) {
      warnings.push(`Bitcoin balance check failed: ${error.message}`);
      details.balanceNote = `Bitcoin balance check failed: ${error.message}`;
      this.logger.error(
        `Bitcoin balance check error: ${error.message}`,
        error.stack,
      );
      return false; // Conservative - deny swap if balance check fails
    }
  }

  /**
   * Cardano-specific balance check
   * Supports Cardano mainnet using eUTXO model
   */
  private async checkCardanoBalance(
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
  ): Promise<boolean> {
    try {
      // Get Cardano wallet provider
      const provider = this.walletService.getWalletProvider('cardano');
      if (!provider) {
        warnings.push(
          'Cardano wallet provider not available - balance check skipped',
        );
        details.balanceNote =
          'Cardano wallet provider not configured - implementation pending';
        return true; // Optimistic - allow swap to proceed
      }

      // Fetch balance for Cardano address
      // For native ADA, use 'native' or the token address for native tokens
      const tokenAddress = request.sellToken.address || 'native';
      const balanceInfo = await this.walletService.getBalance(
        request.sellToken.chain.chainId,
        request.taker,
        tokenAddress,
        'cardano',
      );

      const sellTokenDecimals = request.sellToken.decimals || 6; // Cardano ADA has 6 decimal places (lovelaces)
      const normalizedAmount = this.amountUtils.normalizeAmount(
        request.sellAmount,
        sellTokenDecimals,
        ProviderAmountFormat.WEI, // Actually lovelaces for Cardano
      );

      const balanceLovelaces = BigInt(balanceInfo.balance);
      const requiredLovelaces = BigInt(normalizedAmount);
      const sufficientBalance = balanceLovelaces >= requiredLovelaces;

      if (!sufficientBalance) {
        warnings.push('Insufficient Cardano wallet balance for swap');
        details.balanceDetails = {
          required: normalizedAmount,
          available: balanceInfo.balance,
          token: balanceInfo.symbol || 'ADA',
          requiredFormatted: `${request.sellAmount} (input)`,
          normalizedRequired: normalizedAmount,
          decimalsUsed: sellTokenDecimals,
          note: 'Cardano balance in lovelaces (1 ADA = 1,000,000 lovelaces)',
        };
      } else {
        this.logger.debug(
          `✅ Cardano balance sufficient: ${balanceInfo.balance} lovelaces (${balanceInfo.formattedBalance} ADA)`,
        );
      }

      return sufficientBalance;
    } catch (error) {
      warnings.push(`Cardano balance check failed: ${error.message}`);
      details.balanceNote = `Cardano balance check failed: ${error.message}`;
      this.logger.error(
        `Cardano balance check error: ${error.message}`,
        error.stack,
      );

      // If provider exists but check fails, be conservative
      const provider = this.walletService.getWalletProvider('cardano');
      if (provider) {
        return false;
      }

      // If no provider, be optimistic
      return true;
    }
  }

  /**
   * Substrate-specific balance check
   * Supports Polkadot, Kusama, and other Substrate-based chains
   */
  private async checkSubstrateBalance(
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
  ): Promise<boolean> {
    try {
      // Get Substrate wallet provider
      const provider = this.walletService.getWalletProvider('substrate');
      if (!provider) {
        warnings.push(
          'Substrate wallet provider not available - balance check skipped',
        );
        details.balanceNote =
          'Substrate wallet provider not configured - implementation pending';
        return true; // Optimistic - allow swap to proceed
      }

      // Fetch balance for Substrate address
      const tokenAddress = request.sellToken.address || 'native';
      const balanceInfo = await this.walletService.getBalance(
        request.sellToken.chain.chainId,
        request.taker,
        tokenAddress,
        'substrate',
      );

      const sellTokenDecimals = request.sellToken.decimals || 10; // Polkadot DOT has 10 decimal places (plancks)
      const normalizedAmount = this.amountUtils.normalizeAmount(
        request.sellAmount,
        sellTokenDecimals,
        ProviderAmountFormat.WEI, // Actually plancks for Substrate chains
      );

      const balancePlancks = BigInt(balanceInfo.balance);
      const requiredPlancks = BigInt(normalizedAmount);
      const sufficientBalance = balancePlancks >= requiredPlancks;

      if (!sufficientBalance) {
        warnings.push('Insufficient Substrate wallet balance for swap');
        details.balanceDetails = {
          required: normalizedAmount,
          available: balanceInfo.balance,
          token: balanceInfo.symbol || request.sellToken.symbol,
          requiredFormatted: `${request.sellAmount} (input)`,
          normalizedRequired: normalizedAmount,
          decimalsUsed: sellTokenDecimals,
          note: 'Substrate balance in smallest unit (e.g., plancks for DOT, KSM)',
        };
      } else {
        this.logger.debug(
          `✅ Substrate balance sufficient: ${balanceInfo.balance} plancks (${balanceInfo.formattedBalance} ${balanceInfo.symbol})`,
        );
      }

      return sufficientBalance;
    } catch (error) {
      warnings.push(`Substrate balance check failed: ${error.message}`);
      details.balanceNote = `Substrate balance check failed: ${error.message}`;
      this.logger.error(
        `Substrate balance check error: ${error.message}`,
        error.stack,
      );

      // If provider exists but check fails, be conservative
      const provider = this.walletService.getWalletProvider('substrate');
      if (provider) {
        return false;
      }

      // If no provider, be optimistic
      return true;
    }
  }

  /**
   * Provider category-specific health check
   */
  private async checkProviderHealthByCategory(
    providerCategory: string | null,
    request: UniversalSwapRequestDto,
    warnings: string[],
    details: Record<string, any>,
  ): Promise<boolean> {
    if (!providerCategory) {
      warnings.push('Provider category unknown - health check skipped');
      details.healthNote = 'Provider category could not be determined';
      return true;
    }

    try {
      switch (providerCategory) {
        case 'evm-aggregators':
          const evmHealth = await this.aggregatorManager.getProvidersHealth();
          const evmHealthy = evmHealth.evm.every((h) => h.status === 'healthy');
          if (!evmHealthy) {
            warnings.push('One or more EVM aggregators are unhealthy');
            details.healthDetails = evmHealth.evm;
          }
          return evmHealthy;

        case 'meta':
          // For meta aggregators, check if they respond to basic calls
          try {
            // Simple health check - try to get supported chains
            const testRequest = {
              fromChainId: 1,
              toChainId: 137,
              fromToken: 'ETH',
              toToken: 'MATIC',
              amount: '1000000000000000000',
              slippageBps: 300,
              userAddress: '0xef518DF74d02B35a7D14a9d8aAEA67a681d5d906',
              recipient: '0xef518DF74d02B35a7D14a9d8aAEA67a681d5d906',
            };
            await this.aggregatorManager.getCrossChainRoutes(testRequest);
            details.healthNote = 'Meta aggregators responding normally';
            return true;
          } catch (error) {
            warnings.push('Meta aggregators may be experiencing issues');
            details.healthNote = `Meta aggregator health check failed: ${error.message}`;
            return false;
          }

        case 'solana':
          // For Solana, ensure Rubic meta routes are available
          try {
            const testSolanaQuote = {
              fromMint: 'So11111111111111111111111111111111111111112', // SOL
              toMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
              amount: '1000000000', // 1 SOL (9 decimals)
              slippageBps: 300,
              userPublicKey: 'DJZ7ZD8Cf4KF5Q7JfgXNSPDY7hM1DfgY3wGg9SKUkrfE',
            };
            await this.aggregatorManager.getSolanaQuote(testSolanaQuote);
            details.healthNote = 'Solana providers responding normally';
            this.logger.debug('✅ Solana provider health check passed');
            return true;
          } catch (error) {
            warnings.push('Solana providers may be experiencing issues');
            details.healthNote = `Solana health check failed: ${error.message}`;
            this.logger.warn(
              `⚠️ Solana provider health check failed: ${error.message}`,
            );
            return false;
          }

        default:
          warnings.push(
            `Health check not implemented for provider category: ${providerCategory}`,
          );
          details.healthNote = `Health check not implemented for ${providerCategory}`;
          return true;
      }
    } catch (error) {
      warnings.push(`Provider health check failed: ${error.message}`);
      details.healthNote = `Health check error: ${error.message}`;
      return false;
    }
  }

  // ===== APPROVAL MANAGEMENT ENDPOINTS =====

  /**
   * Check approval status
   */
  @Post('approval/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check token approval status' })
  @ApiResponse({
    status: 200,
    description: 'Approval status retrieved successfully',
  })
  async getApprovalStatus(@Body() request: ApprovalStatusRequestDto) {
    this.logger.log(
      `Checking approval status for token ${request.tokenAddress}`,
    );

    try {
      return await this.approvalService.getApprovalStatus(
        request.chainId,
        request.tokenAddress,
        request.owner,
        request.spender,
        request.amount,
      );
    } catch (error) {
      this.logger.error(
        `Failed to get approval status: ${error.message}`,
        error.stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error.message.includes('Invalid token address')) {
        throw new BadRequestException({
          message: 'Invalid token address provided.',
          error: 'InvalidTokenAddress',
          details:
            'The provided token address is not valid or does not exist on this chain.',
        });
      } else if (error.message.includes('Invalid wallet address')) {
        throw new BadRequestException({
          message: 'Invalid wallet address provided.',
          error: 'InvalidWalletAddress',
          details:
            'The owner or spender address is not a valid Ethereum address.',
        });
      } else if (error.message.includes('network')) {
        throw new ServiceUnavailableException({
          message: 'Network error occurred while checking approval.',
          error: 'NetworkError',
          details: 'There was a network connectivity issue. Please try again.',
        });
      } else {
        throw new InternalServerErrorException({
          message: 'Failed to check approval status. Please try again.',
          error: 'ApprovalServiceError',
          details:
            'An unexpected error occurred while checking approval status.',
        });
      }
    }
  }

  /**
   * Execute approval transaction
   */
  @Post('approval/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute token approval transaction' })
  @ApiResponse({
    status: 200,
    description: 'Approval executed successfully',
  })
  async executeApproval(@Body() request: ApprovalRequestDto) {
    this.logger.log(`Executing approval for token ${request.tokenAddress}`);

    try {
      return await this.approvalService.executeApproval(
        request.chainId,
        request.privateKey,
        request.tokenAddress,
        request.spender,
        request.amount,
      );
    } catch (error) {
      this.logger.error(
        `Failed to execute approval: ${error.message}`,
        error.stack,
      );

      // Transform specific errors into appropriate HTTP exceptions
      if (
        error.message.includes('Insufficient funds') ||
        error.message.includes('Insufficient balance')
      ) {
        throw new BadRequestException({
          message:
            'Insufficient funds for approval transaction. Please check your wallet balance.',
          error: 'InsufficientFunds',
          details:
            'The wallet does not have enough balance to cover the approval transaction gas fees.',
        });
      } else if (error.message.includes('Invalid private key')) {
        throw new BadRequestException({
          message: 'Invalid private key provided.',
          error: 'InvalidPrivateKey',
          details:
            'The provided private key is not valid or properly formatted.',
        });
      } else if (error.message.includes('Invalid token address')) {
        throw new BadRequestException({
          message: 'Invalid token address provided.',
          error: 'InvalidTokenAddress',
          details:
            'The provided token address is not valid or does not exist on this chain.',
        });
      } else if (error.message.includes('Gas estimation failed')) {
        throw new BadRequestException({
          message: 'Gas estimation failed for approval transaction.',
          error: 'GasEstimationFailed',
          details: 'Unable to estimate gas for the approval transaction.',
        });
      } else if (error.message.includes('network')) {
        throw new ServiceUnavailableException({
          message: 'Network error occurred during approval.',
          error: 'NetworkError',
          details: 'There was a network connectivity issue. Please try again.',
        });
      } else {
        throw new InternalServerErrorException({
          message: 'Approval execution failed. Please try again.',
          error: 'ApprovalExecutionFailed',
          details: 'An unexpected error occurred during approval execution.',
        });
      }
    }
  }

  // ===== INFORMATION & UTILITY ENDPOINTS =====

  /**
   * Get supported chains from all aggregators
   */
  @Get('supported-chains')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get supported chains with detailed information',
    description:
      'Retrieves detailed information about chains supported by all aggregators, including chain names, native currencies, and other metadata from ChainList API. This endpoint dynamically fetches supported chains from each aggregator API and enriches them with comprehensive chain data.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Successfully retrieved supported chains with detailed information.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            supportedChains: {
              type: 'array',
              description:
                'Array of enhanced chain information for all supported chains',
              items: {
                type: 'object',
                properties: {
                  chainId: { type: 'number', example: 1 },
                  name: { type: 'string', example: 'Ethereum Mainnet' },
                  shortName: { type: 'string', example: 'eth' },
                  nativeCurrency: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', example: 'Ether' },
                      symbol: { type: 'string', example: 'ETH' },
                      decimals: { type: 'number', example: 18 },
                    },
                  },
                  network: { type: 'string', example: 'mainnet' },
                  infoURL: { type: 'string', example: 'https://ethereum.org' },
                  explorers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', example: 'Etherscan' },
                        url: {
                          type: 'string',
                          example: 'https://etherscan.io',
                        },
                        standard: { type: 'string', example: 'EIP3091' },
                      },
                    },
                  },
                  icon: { type: 'string', example: 'ethereum' },
                },
              },
              example: [
                {
                  chainId: 1,
                  name: 'Ethereum Mainnet',
                  shortName: 'eth',
                  nativeCurrency: {
                    name: 'Ether',
                    symbol: 'ETH',
                    decimals: 18,
                  },
                  network: 'mainnet',
                  infoURL: 'https://ethereum.org',
                },
                {
                  chainId: 137,
                  name: 'Polygon Mainnet',
                  shortName: 'matic',
                  nativeCurrency: {
                    name: 'MATIC',
                    symbol: 'MATIC',
                    decimals: 18,
                  },
                  network: 'matic',
                  infoURL: 'https://polygon.technology',
                },
              ],
            },
            aggregatorChains: {
              type: 'object',
              description:
                'Breakdown of enhanced chain information by aggregator',
              additionalProperties: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    chainId: { type: 'number' },
                    name: { type: 'string' },
                    shortName: { type: 'string' },
                    nativeCurrency: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        symbol: { type: 'string' },
                        decimals: { type: 'number' },
                      },
                    },
                  },
                },
              },
              example: {
                ZeroX: [
                  {
                    chainId: 1,
                    name: 'Ethereum Mainnet',
                    shortName: 'eth',
                    nativeCurrency: {
                      name: 'Ether',
                      symbol: 'ETH',
                      decimals: 18,
                    },
                  },
                ],
                Odos: [
                  {
                    chainId: 137,
                    name: 'Polygon Mainnet',
                    shortName: 'matic',
                    nativeCurrency: {
                      name: 'MATIC',
                      symbol: 'MATIC',
                      decimals: 18,
                    },
                  },
                ],
              },
            },
          },
        },
        timestamp: {
          type: 'string',
          format: 'date-time',
          example: '2024-01-15T10:30:00Z',
        },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description:
      'Internal server error occurred while fetching supported chains.',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Failed to retrieve supported chains',
        },
        error: { type: 'string', example: 'SupportedChainsError' },
        details: {
          type: 'string',
          example:
            'An unexpected error occurred while fetching supported chains from aggregators.',
        },
      },
    },
  })
  async getSupportedChains() {
    try {
      this.logger.log('Fetching supported chains from all aggregators...');

      // Get supported chains from quote service which will fetch from all aggregators
      const result = await this.quoteService.getSupportedChains();

      this.logger.log(
        `Successfully retrieved ${result.supportedChains.length} unique supported chains`,
      );

      // Return raw data - ResponseTransformInterceptor will wrap it
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to get supported chains: ${error.message}`,
        error.stack,
      );

      throw new InternalServerErrorException({
        message: 'Failed to retrieve supported chains',
        error: 'SupportedChainsError',
        details:
          'An unexpected error occurred while fetching supported chains from aggregators.',
      });
    }
  }

  /**
   * Get supported aggregators for a chain
   * Supports both numeric chainIds (EVM: 1, 137, etc.) and string chainIds (Bitcoin: "bitcoin-mainnet", Solana: "solana-mainnet")
   */
  @Get('aggregators')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get supported aggregators for a chain',
    description: `
    Get list of aggregators that support swaps on the specified chain.
    
    **Supported chainId formats:**
    - Numeric chainIds for EVM chains: 1 (Ethereum), 137 (Polygon), 56 (BSC), etc.
    - String chainIds for native L1 chains: "bitcoin-mainnet", "litecoin-mainnet", "solana-mainnet"
    
    **Example requests:**
    - EVM chain: GET /aggregators?chainId=1
    - Bitcoin: GET /aggregators?chainId=bitcoin-mainnet
    - Solana: GET /aggregators?chainId=solana-mainnet
    `,
  })
  @ApiQuery({
    name: 'chainId',
    description:
      'Chain ID (numeric for EVM chains like 1, 137, or string for native L1 like "bitcoin-mainnet")',
    type: String,
    example: '1',
  })
  @ApiResponse({
    status: 200,
    description: 'Supported aggregators retrieved successfully',
  })
  async getSupportedAggregators(
    @Query('chainId') chainId: string | number,
  ): Promise<AggregatorType[]> {
    this.logger.log(`Getting supported aggregators for chain ${chainId}`);

    try {
      // Normalize chainId: try to parse as number if it's a numeric string
      let normalizedChainId: number | string = chainId;
      if (typeof chainId === 'string') {
        // Check if it's a numeric string (EVM chain)
        const parsed = parseInt(chainId, 10);
        if (!isNaN(parsed) && parsed.toString() === chainId) {
          normalizedChainId = parsed;
        }
        // Otherwise keep as string (native L1 chain like "bitcoin-mainnet")
      }

      // Use aggregator manager for supported aggregators
      return await this.aggregatorManager.getEnhancedSupportedAggregators(
        normalizedChainId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to get supported aggregators: ${error.message}`,
        error.stack,
      );

      if (
        error.message.includes('Invalid chain ID') ||
        error.message.includes('Unsupported chain')
      ) {
        throw new BadRequestException({
          message: 'Invalid or unsupported chain ID.',
          error: 'InvalidChainId',
          details: 'The provided chain ID is not supported by the service.',
        });
      } else {
        throw new InternalServerErrorException({
          message: 'Failed to get supported aggregators. Please try again.',
          error: 'AggregatorServiceError',
          details:
            'An unexpected error occurred while fetching supported aggregators.',
        });
      }
    }
  }

  /**
   * Health check endpoint
   */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Health check for universal swap service' })
  @ApiResponse({
    status: 200,
    description: 'Service is healthy',
  })
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  }

  // ===== HELPER METHODS FOR ENHANCED UNIVERSAL FLOW =====

  /**
   * Create error metadata for failed requests
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
}
