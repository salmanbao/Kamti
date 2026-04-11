import { Injectable } from '@nestjs/common';
import { parseUnits } from 'viem';
import { BaseSwapExecutor } from './base-swap-executor';
import {
  ExecutionContext,
  ExecutionResult,
} from '../ports/swap-executor.interface';
import { RouteQuote, SwapQuote } from '@swap/models/ports';
import { AggregatorType } from '@swap/models/swap-request.model';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { ApprovalService } from '@swap/services/blockchain/approval/approval.service';
import { isNativeToken } from '@shared/utils/chain.utils';
import { normalizeChainId } from '@shared/config/unified-token-configuration.config';
import { RubicService } from '@swap/services/providers/meta/rubic.service';
import { AggregatorManagerService } from '../../aggregation/aggregator-manager.service';
import { RouteRequest } from '@swap/models/ports';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { GasEstimationService } from '../gas/gas-estimation.service';
import {
  CHAIN_FEE_CONFIG,
  AGGREGATOR_TOLERANCES,
  ChainFeeConfig,
  AggregatorTolerances,
  GAS_ESTIMATION_CONFIG,
  GasEstimationConfig,
  detectEcosystemFromChainId,
} from '@config/swap-config';
import { EcosystemFeeCalculatorFactory } from '../fee-calculators/ecosystem-fee-calculator.factory';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */

/* eslint-disable @typescript-eslint/no-unused-vars */

/**
 * Meta Swap Executor for cross-chain swaps via Rubic, Socket, or other bridge protocols
 *
 * Execution Flow:
 * 1. Validate multi-step cross-chain route
 * 2. Execute approval on source chain (if needed)
 * 3. Initiate cross-chain transfer on source chain
 * 4. Monitor bridge status and confirmations
 * 5. Wait for destination chain completion
 *
 * Design Patterns:
 * - Strategy Pattern: Implements ISwapExecutor interface
 * - Template Method: Extends BaseSwapExecutor with cross-chain logic
 * - Dependency Injection: Uses WalletService, AggregatorManager
 *
 * Cross-Chain Features:
 * - Multi-step transaction coordination
 * - Bridge protocol integration (Rubic, Socket, Stargate, etc.)
 * - Source and destination chain monitoring
 * - Status tracking across chains
 * - Estimated completion time tracking
 */
@Injectable()
export class MetaSwapExecutor extends BaseSwapExecutor {
  // Track current execution ecosystem for waitForConfirmation
  private currentEcosystem: 'evm' | 'solana' | 'tron' | 'bitcoin' = 'evm';
  // Track current execution context for accessing route/providerRef in waitForConfirmation
  private currentExecutionContext?: ExecutionContext;

  // Configuration
  private readonly chainFeeConfig: ChainFeeConfig;
  private readonly aggregatorTolerances: AggregatorTolerances;
  private readonly gasConfig: GasEstimationConfig;

  constructor(
    private readonly walletService: WalletService,
    private readonly approvalService: ApprovalService,
    private readonly rubicService: RubicService,
    private readonly aggregatorManager: AggregatorManagerService,
    protected readonly winstonLogger: WinstonLoggerService,
    gasEstimationService: GasEstimationService,
    feeCalculatorFactory: EcosystemFeeCalculatorFactory,
  ) {
    super(
      winstonLogger,
      'MetaSwapExecutor',
      gasEstimationService,
      feeCalculatorFactory,
    );
    this.chainFeeConfig = CHAIN_FEE_CONFIG;
    this.aggregatorTolerances = AGGREGATOR_TOLERANCES;
    this.gasConfig = GAS_ESTIMATION_CONFIG;

    this.logger.log(
      'MetaSwapExecutor initialized with configuration',
      JSON.stringify({
        solanaGasCost: this.chainFeeConfig.solana.totalGasCost,
        tronBridgeCost: this.chainFeeConfig.tron.typicalBridgeCost,
        rubicRoundingBuffer:
          this.aggregatorTolerances.providers.rubic.roundingBuffer,
      }),
    );
  }

  /**
   * Identify this executor
   */
  getName(): string {
    return 'Meta Swap Executor (Cross-Chain)';
  }

  /**
   * Check if this executor can handle the given route
   * Meta executor handles:
   * 1. Cross-chain routes (multiple steps with different chains)
   * 2. Native L1 swaps via Rubic (Bitcoin ↔ EVM, Litecoin, etc.)
   * 3. Bridge-based swaps between different ecosystems
   */
  canExecute(route: RouteQuote): boolean {
    if (!route.steps || route.steps.length === 0) {
      return false;
    }

    const firstStep = route.steps[0];
    const lastStep = route.steps[route.steps.length - 1];

    // Cross-chain detection: different source and destination chains
    const isCrossChain = firstStep.chainId !== lastStep.chainId;

    // Check for native L1 swaps via providerRef
    const swapQuote = route.providerRef as any;
    const isRubicNativeL1 =
      swapQuote?.aggregator === 'rubic' &&
      (this.isNativeL1ChainId(firstStep.chainId) ||
        this.isNativeL1ChainId(lastStep.chainId));

    // Check for Symbiosis on-chain swaps (Tron, etc.)
    const isSymbiosisOnChain =
      swapQuote?.aggregator === 'symbiosis' &&
      (this.isNativeL1ChainId(firstStep.chainId) ||
        this.isNativeL1ChainId(lastStep.chainId));

    // Detect if the route is Solana (on-chain Solana handled here too)
    const isSolanaRoute = this.detectEcosystem(firstStep.chainId) === 'solana';

    // Meta executor handles:
    // 1. Cross-chain swaps (any number of steps, including direct bridge)
    // 2. On-chain Solana swaps (Jupiter/Raydium)
    // 3. Native L1 swaps via Rubic (Bitcoin, Litecoin, etc.)
    // 4. Native L1 on-chain swaps via Symbiosis (Tron, etc.)
    return (
      isCrossChain || isSolanaRoute || isRubicNativeL1 || isSymbiosisOnChain
    );
  }

  /**
   * Check if chainId represents a native L1 blockchain that Rubic supports
   * Includes Bitcoin (5555), Litecoin, Dogecoin, etc.
   */
  private isNativeL1ChainId(chainId: number | string): boolean {
    // Bitcoin and related chain IDs in Rubic
    const nativeL1ChainIds = [
      5555, // Bitcoin in Rubic
      'bitcoin',
      'bitcoin-mainnet',
      'btc',
      'litecoin',
      'litecoin-mainnet',
      'ltc',
      'dogecoin',
      'dogecoin-mainnet',
      'doge',
      'solana',
      'solana-mainnet',
      'sol',
      195,
      'tron',
      'tron-mainnet',
      'trx',
    ];

    const chainIdStr = chainId.toString().toLowerCase();
    return nativeL1ChainIds.some(
      (id) => id === chainId || id.toString() === chainIdStr,
    );
  }

  /**
   * Detect ecosystem (evm, solana, bitcoin, etc.) from chainId
   * Supports both numeric and string chainIds for multi-chain compatibility
   *
   * @param chainId - Chain identifier (can be number or string)
   * @returns Ecosystem type
   */
  private detectEcosystem(
    chainId: number | string,
  ): 'evm' | 'solana' | 'bitcoin' | 'tron' {
    // CRITICAL FIX: Check original chainId FIRST before normalization
    // Normalization might fail at runtime, so we need direct checks
    const originalStr = String(chainId).toLowerCase();
    const originalNum =
      typeof chainId === 'number' ? chainId : parseInt(String(chainId), 10);

    // Direct Solana detection on original chainId (BEFORE normalization)
    // Solana numeric chainIds used by aggregators
    if (
      originalNum === 1151111081099710 || // Rubic's primary Solana chainId
      originalNum === 7565164 || // Alternative Solana chainId variant
      originalStr.includes('solana') ||
      originalStr === 'sol' ||
      originalStr === 'solana-mainnet'
    ) {
      this.logger.debug(
        '🔍 detectEcosystem: Solana detected from ORIGINAL chainId',
        {
          originalChainId: chainId,
          typeOf: typeof chainId,
          originalStr,
          originalNum,
        },
      );
      return 'solana';
    }

    // Direct Tron detection on original chainId (BEFORE normalization)
    if (
      chainId === 195 ||
      chainId === '195' ||
      originalNum === 195 ||
      originalStr === 'tron' ||
      originalStr === 'tron-mainnet' ||
      originalStr === 'trx'
    ) {
      this.logger.debug(
        '🔍 detectEcosystem: Tron detected from ORIGINAL chainId',
        {
          originalChainId: chainId,
          typeOf: typeof chainId,
          originalStr,
          originalNum,
        },
      );
      return 'tron';
    }

    const normalized = normalizeChainId(chainId);
    const cidStr = normalized.toString().toLowerCase();

    // Debug logging for all detection attempts
    this.logger.debug('🔍 detectEcosystem: Detection process', {
      originalChainId: chainId,
      originalType: typeof chainId,
      normalized,
      normalizedType: typeof normalized,
      cidStr,
      checks: {
        isTronOriginal: chainId === 195 || originalNum === 195,
        isTronNormalized: cidStr.includes('tron') || cidStr === 'trx',
        isSolana: normalized === 'solana-mainnet',
        isBitcoin: cidStr.includes('bitcoin') || cidStr.includes('litecoin'),
      },
    });

    // Solana: any alias normalized to 'solana-mainnet'
    if (
      normalized === 'solana-mainnet' ||
      (typeof normalized === 'string' &&
        normalized.toLowerCase().includes('solana'))
    ) {
      return 'solana';
    }

    // Bitcoin / Litecoin family detection (native L1 via Rubic / Thorchain etc.)
    if (
      cidStr.includes('bitcoin') ||
      cidStr.includes('litecoin') ||
      cidStr === 'btc' ||
      cidStr === 'ltc' ||
      normalized === 5555
    ) {
      return 'bitcoin';
    }

    // Tron detection after normalization (backup check)
    if (cidStr.includes('tron') || cidStr === 'trx' || normalized === 195) {
      return 'tron';
    }

    // Default: treat numeric (EVM) or unknown strings as EVM
    return 'evm';
  }

  /**
   * Cross-chain specific validation
   * Comprehensive validation for cross-chain swaps including:
   * - Route structure and steps validation
   * - Source and destination chain compatibility
   * - Transaction data completeness
   * - Balance and allowance validation
   * - Bridge protocol requirements
   * - Quote expiry and freshness
   * - Price impact and slippage checks
   * - Gas estimation validation
   */
  protected async validateSpecific(
    context: ExecutionContext,
  ): Promise<string[]> {
    const errors: string[] = [];

    try {
      const route = context.request.route;
      const userWallet = context.request.userWallet;
      const recipient = context.request.recipient;

      this.logger.log(
        '🔍 VALIDATION STARTED - Starting meta executor cross-chain validation',
        {
          routeId: route.routeId,
          stepsCount: route.steps?.length || 0,
          timestamp: Date.now(),
        },
      );

      // ============================================================================
      // 1. VALIDATE PROVIDER REFERENCE
      // ============================================================================
      if (!route.providerRef || typeof route.providerRef !== 'object') {
        errors.push('Missing provider reference data in route');
        this.logger.error('Missing provider reference in route', {
          routeId: route.routeId,
          hasProviderRef: !!route.providerRef,
        });
        return errors;
      }

      const swapQuote = route.providerRef as SwapQuote;

      this.logger.debug('Cross-chain route details', {
        aggregator: swapQuote.aggregator,
        stepsCount: route.steps?.length || 0,
        sourceChain: route.steps?.[0]?.chainId,
        destChain: route.steps?.[route.steps.length - 1]?.chainId,
        routeId: route.routeId,
        isCrossChain:
          route.steps?.[0]?.chainId !==
          route.steps?.[route.steps.length - 1]?.chainId,
      });

      // ============================================================================
      // 2. VALIDATE ROUTE STRUCTURE
      // ============================================================================
      this.logger.debug('Validating route structure');

      if (!route.steps || route.steps.length === 0) {
        errors.push('Route must have at least one step');
        this.logger.error('Route has no steps', {
          routeId: route.routeId,
        });
        return errors;
      }

      // Cross-chain routes typically have at least 2 steps (source swap/bridge + dest swap)
      // But some bridges might use single step, so we validate differently
      const isCrossChain =
        route.steps[0].chainId !== route.steps[route.steps.length - 1].chainId;

      if (isCrossChain && route.steps.length < 2) {
        this.logger.warn(
          'Cross-chain route has only 1 step - may be direct bridge',
          {
            routeId: route.routeId,
            stepsCount: route.steps.length,
          },
        );
      }

      // Validate each step has required fields
      for (let i = 0; i < route.steps.length; i++) {
        const step = route.steps[i];

        if (!step.chainId) {
          errors.push(`Step ${i + 1} missing chainId`);
          this.logger.error(`Step ${i + 1} missing chainId`, {
            stepIndex: i + 1,
            routeId: route.routeId,
          });
        }

        if (!step.kind || !['swap', 'bridge', 'native'].includes(step.kind)) {
          errors.push(`Step ${i + 1} has invalid kind: ${step.kind}`);
          this.logger.error(`Step ${i + 1} has invalid kind`, {
            stepIndex: i + 1,
            kind: step.kind,
            routeId: route.routeId,
          });
        }

        // Validate step details contain necessary info
        if (step.details) {
          if (i === 0 && !step.details.fromToken) {
            this.logger.warn(` Step 1 missing fromToken in details`);
          }

          if (i === route.steps.length - 1 && !step.details.toToken) {
            this.logger.warn(` Final step missing toToken in details`);
          }
        }
      }

      const sourceStep = route.steps[0];
      const destStep = route.steps[route.steps.length - 1];

      this.logger.debug('Route structure validated successfully', {
        stepsCount: route.steps.length,
        isCrossChain,
        routeId: route.routeId,
      });

      // ============================================================================
      // 3. VALIDATE TRANSACTION DATA
      // ============================================================================
      this.logger.log(' Validating transaction data...');

      // Detect if this is a deposit-based trade (CEX) early for proper validation
      // Cast to any to access depositInfo (defined in interface but might not be in compile cache)
      const isDepositBasedTrade = !!(swapQuote as any).depositInfo;

      if (isDepositBasedTrade) {
        const depositInfo = (swapQuote as any).depositInfo;
        this.logger.debug(' Deposit-based trade detected (CEX)', {
          depositAddress: depositInfo?.depositAddress,
          transferEcosystem: depositInfo?.transferEcosystem,
          providerType: depositInfo?.providerType,
        });

        // For deposit trades, validate deposit address exists
        if (!depositInfo?.depositAddress) {
          errors.push('Missing deposit address for CEX trade');
          this.logger.error(' Missing deposit address');
        } else {
          this.logger.debug(' Deposit address present', {
            address: depositInfo.depositAddress,
          });
        }

        // For deposit trades, transaction structure is simpler (native transfer)
        // No need to validate complex transaction data or approval targets
      } else {
        // Non-deposit trades: validate transaction data based on ecosystem

        // Detect source chain ecosystem to validate transaction format correctly
        const sourceEcosystem = this.detectEcosystem(sourceStep.chainId);

        // Check ecosystem-specific transaction formats
        const isSolanaTransaction =
          (swapQuote as any).isSolanaTransaction === true ||
          sourceEcosystem === 'solana';
        const isTronTransaction = sourceEcosystem === 'tron';
        const isBitcoinTransaction = sourceEcosystem === 'bitcoin';

        if (isSolanaTransaction) {
          // Solana transactions return { data: "base64..." } format
          if (!swapQuote.data) {
            errors.push('Missing Solana transaction data');
            this.logger.error(' Missing Solana transaction data');
          } else {
            this.logger.debug(' Solana transaction data present', {
              dataLength: swapQuote.data?.length || 0,
            });
          }
        } else if (isTronTransaction) {
          // Tron transactions require 'to' address and 'value' for native TRX
          // Smart contract calls also need 'data' field
          if (!swapQuote.to) {
            errors.push('Missing Tron destination address');
            this.logger.error(' Missing "to" address in Tron swap quote');
          } else {
            this.logger.debug(' Tron destination address present', {
              to: swapQuote.to,
            });
          }

          // Data field is optional for Tron (native TRX transfers don't need it)
          if (
            swapQuote.data &&
            swapQuote.data !== '' &&
            swapQuote.data !== '0x'
          ) {
            this.logger.debug(' Tron smart contract data present', {
              dataLength: swapQuote.data.length,
            });
          } else {
            this.logger.debug(' Tron native transfer (no contract data)');
          }
        } else if (isBitcoinTransaction) {
          // Bitcoin transactions typically need 'to' address and 'value'
          // No 'data' field for Bitcoin (no smart contracts on base layer)
          if (!swapQuote.to) {
            errors.push('Missing Bitcoin destination address');
            this.logger.error(' Missing "to" address in Bitcoin swap quote');
          } else {
            this.logger.debug(' Bitcoin destination address present', {
              to: swapQuote.to,
            });
          }

          if (!swapQuote.value || swapQuote.value === '0') {
            errors.push('Missing Bitcoin transaction value');
            this.logger.error(' Missing or zero value in Bitcoin swap quote');
          } else {
            this.logger.debug(' Bitcoin value present', {
              value: swapQuote.value,
            });
          }
        } else {
          // EVM transactions require 'to' and 'data' fields
          if (!swapQuote.to) {
            errors.push(
              'Missing source chain transaction destination address (bridge contract)',
            );
            this.logger.error(' Missing "to" address in swap quote');
          } else {
            this.logger.debug(' Transaction destination address present', {
              to: swapQuote.to,
            });
          }

          if (!swapQuote.data) {
            errors.push('Missing transaction data for bridge contract call');
            this.logger.error(' Missing transaction data');
          } else {
            this.logger.debug(' Transaction data present', {
              dataLength: swapQuote.data.length,
            });
          }
        }
      }

      // Validate transaction value (for native token transfers on EVM)
      if (swapQuote.value && swapQuote.value !== '0') {
        this.logger.debug('Native token transfer detected', {
          value: swapQuote.value,
        });
      }

      // ============================================================================
      // 4. VALIDATE AMOUNTS
      // ============================================================================
      this.logger.log(' Validating amounts...');

      if (!swapQuote.sellAmount || swapQuote.sellAmount === '0') {
        errors.push('Invalid sell amount in swap quote');
        this.logger.error(' Invalid sell amount', {
          sellAmount: swapQuote.sellAmount,
        });
      }

      if (!swapQuote.buyAmount || swapQuote.buyAmount === '0') {
        errors.push('Invalid buy amount in swap quote');
        this.logger.error(' Invalid buy amount', {
          buyAmount: swapQuote.buyAmount,
        });
      }

      // Validate minBuyAmount (slippage protection)
      // Note: Amounts might be in wei (no decimal) or decimal format (with decimal point)
      // For validation purposes, we use floating point comparison which is safe
      if (swapQuote.minBuyAmount && swapQuote.buyAmount) {
        try {
          const buyAmountNum = parseFloat(swapQuote.buyAmount);
          const minBuyAmountNum = parseFloat(swapQuote.minBuyAmount);

          if (minBuyAmountNum > buyAmountNum) {
            errors.push('minBuyAmount cannot be greater than buyAmount');
            this.logger.error(' Invalid minBuyAmount', {
              minBuyAmount: swapQuote.minBuyAmount,
              buyAmount: swapQuote.buyAmount,
            });
          } else {
            // Calculate slippage percentage
            const slippagePercent =
              ((buyAmountNum - minBuyAmountNum) / buyAmountNum) * 100;

            this.logger.debug('Slippage tolerance from minBuyAmount', {
              slippagePercent: `${slippagePercent.toFixed(2)}%`,
              buyAmount: buyAmountNum,
              minBuyAmount: minBuyAmountNum,
            });

            if (slippagePercent > 50) {
              // > 50%
              this.logger.warn(' Extremely high slippage tolerance', {
                slippagePercent: `${slippagePercent.toFixed(2)}%`,
              });
            } else if (slippagePercent > 5) {
              // > 5%
              this.logger.warn(' High slippage tolerance', {
                slippagePercent: `${slippagePercent.toFixed(2)}%`,
              });
            }
          }
        } catch (amountError) {
          this.logger.warn(' Could not validate amounts/slippage', {
            error: amountError.message,
            buyAmount: swapQuote.buyAmount,
            minBuyAmount: swapQuote.minBuyAmount,
          });
        }
      }

      this.logger.log(' Amounts validated');

      // ============================================================================
      // 5. VALIDATE QUOTE EXPIRY
      // ============================================================================
      this.logger.log(' Validating quote expiry...');
      const now = Date.now();

      // CRITICAL DEBUG: Log all timeout-related fields
      this.logger.debug('🔍 TIMEOUT DEBUG - Route level fields', {
        routeQuotedAt: route.quotedAt,
        routeExpiresAt: route.expiresAt,
        routeTimeoutMs: route.timeoutMs,
      });

      this.logger.debug('🔍 TIMEOUT DEBUG - SwapQuote (providerRef) fields', {
        swapQuoteTimestamp: swapQuote.timestamp,
        swapQuoteTimeoutMs: swapQuote.timeoutMs,
        swapQuoteExpiresAt: swapQuote.expiresAt,
        swapQuoteAggregator: swapQuote.aggregator,
      });

      if (typeof swapQuote.expiresAt === 'number') {
        const remainingMs = swapQuote.expiresAt - now;
        const quoteAge = swapQuote.timestamp ? now - swapQuote.timestamp : 0;
        
        this.logger.debug('Quote absolute expiry check', {
          expiresAt: swapQuote.expiresAt,
          remainingSeconds: Math.round(remainingMs / 1000),
          quoteAgeSeconds: Math.round(quoteAge / 1000),
          aggregator: swapQuote.aggregator,
        });

        if (remainingMs <= 0) {
          // Only allow very recently fetched quotes (< 5s) to proceed despite expiry
          // This accounts for network latency but doesn't mask real expiry issues
          if (quoteAge < 5000) {
            this.logger.warn(
              '⚠️ Quote technically expired but just fetched, proceeding with caution',
              {
                expirySecondsAgo: Math.abs(Math.round(remainingMs / 1000)),
                quoteAgeSeconds: Math.round(quoteAge / 1000),
                aggregator: swapQuote.aggregator,
              },
            );
          } else {
            errors.push(
              `Quote expired: provider timeout elapsed (expired ${Math.abs(Math.round(remainingMs / 1000))}s ago, quote age: ${Math.round(quoteAge / 1000)}s)`,
            );
            this.logger.error('⏰ Quote expired (absolute expiry)', {
              expirySecondsAgo: Math.abs(Math.round(remainingMs / 1000)),
              quoteAgeSeconds: Math.round(quoteAge / 1000),
              aggregator: swapQuote.aggregator,
              message:
                'Quote too old for execution. Consider optimizing orchestration flow or refetching quotes closer to execution time.',
            });
          }
        } else if (remainingMs < 15000) {
          this.logger.warn('⚠️ Quote approaching expiry', {
            remainingSeconds: Math.round(remainingMs / 1000),
          });
        } else {
          this.logger.log('✅ Quote age acceptable (absolute expiry)');
        }
      } else if (swapQuote.timestamp) {
        const quoteAge = now - swapQuote.timestamp;
        // Cross-chain quotes typically have longer expiry (60-120 seconds)
        // Rubic quotes are valid for ~120 seconds unless provider sends timeoutMs
        const defaultMaxAge = swapQuote.aggregator === 'rubic' ? 120000 : 90000;
        const maxAge = swapQuote.timeoutMs || defaultMaxAge;

        this.logger.debug('Quote age check', {
          ageSeconds: Math.round(quoteAge / 1000),
          maxAgeSeconds: maxAge / 1000,
          aggregator: swapQuote.aggregator,
        });

        if (quoteAge > maxAge) {
          errors.push(
            `Quote expired: ${Math.round(quoteAge / 1000)}s old (max ${maxAge / 1000}s for ${swapQuote.aggregator || 'cross-chain'})`,
          );
          this.logger.error(' Quote expired', {
            ageSeconds: Math.round(quoteAge / 1000),
            maxAgeSeconds: maxAge / 1000,
          });
        } else if (quoteAge > maxAge * 0.85) {
          this.logger.warn(' Quote approaching expiry', {
            ageSeconds: Math.round(quoteAge / 1000),
            remainingSeconds: Math.round((maxAge - quoteAge) / 1000),
          });
        } else {
          this.logger.log(' Quote age acceptable');
        }
      } else {
        this.logger.warn(' No timestamp on quote - cannot validate expiry');
      }

      // ============================================================================
      // 6. VALIDATE SOURCE CHAIN BALANCE
      // ============================================================================
      this.logger.log(' Validating source chain balance...');

      const sourceChainId = normalizeChainId(sourceStep.chainId);

      // Get sell token address from route steps or swap quote
      let sellTokenAddress = swapQuote.sellToken;
      if (!sellTokenAddress && sourceStep.details?.fromToken) {
        sellTokenAddress = sourceStep.details.fromToken;
      }

      if (!sellTokenAddress) {
        this.logger.warn(
          ' Sell token address not found - skipping balance validation',
        );
      } else {
        try {
          // Determine if native token or ERC-20
          const isNative = isNativeToken(sellTokenAddress);

          // Detect ecosystem based on chainId (multi-chain support)
          const ecosystem = this.detectEcosystem(sourceChainId);

          this.logger.debug('Fetching balance', {
            chain: sourceChainId,
            token: sellTokenAddress,
            wallet: userWallet,
            ecosystem,
            isNative,
          });

          const balanceInfo = await this.walletService.getBalance(
            sourceChainId,
            userWallet,
            isNative ? undefined : sellTokenAddress,
            ecosystem,
          );

          const balance = BigInt(balanceInfo.balance);

          // Convert sellAmount to BigInt - handle both wei string and decimal string
          let sellAmount: bigint;
          const sellAmountStr = swapQuote.sellAmount;

          // Check if it's already in wei format (no decimal point) or needs conversion
          if (sellAmountStr.includes('.')) {
            // It's a decimal string like "0.000999", need to convert using decimals
            sellAmount = parseUnits(sellAmountStr, balanceInfo.decimals);
            this.logger.debug('Converted decimal amount to wei', {
              decimal: sellAmountStr,
              wei: sellAmount.toString(),
            });
          } else {
            // It's already in wei format
            sellAmount = BigInt(sellAmountStr);
          }

          // Check if swapFullBalance flag is set - if so, skip balance validation for native tokens
          // because preExecute() will adjust the amount to account for gas fees
          const swapFullBalance = context.request.swapFullBalance || false;

          // Debug log: Track swapFullBalance flag in validation
          this.logger.debug('🔍 Validation: swapFullBalance flag', {
            rawValue: context.request.swapFullBalance,
            type: typeof context.request.swapFullBalance,
            normalizedValue: swapFullBalance,
            isNative,
            willSkipValidation: isNative && swapFullBalance,
          });

          if (isNative && swapFullBalance) {
            // For full balance swaps with native tokens, skip balance validation
            // preExecute() will handle amount adjustment
            this.logger.log(
              ' Skipping balance validation for native token full balance swap - amount will be adjusted in preExecute()',
              {
                chain: sourceChainId,
                token: balanceInfo.symbol,
                balance: (
                  Number(balance) / Math.pow(10, balanceInfo.decimals)
                ).toFixed(4),
                requestedAmount: (
                  Number(sellAmount) / Math.pow(10, balanceInfo.decimals)
                ).toFixed(4),
              },
            );
          } else {
            // Calculate gas buffer for native token based on ecosystem
            // Different chains have different fee structures, so we need ecosystem-specific logic
            let gasBuffer = 0n;
            if (isNative) {
              // Detect ecosystem to apply proper fee calculation
              const sourceEcosystem = this.detectEcosystem(sourceChainId);

              if (sourceEcosystem === 'solana') {
                // SOLANA: Use fixed fee structure (signature + compute + rent + buffer)
                // Solana fees are very small (~0.0001-0.001 SOL) regardless of swap amount
                try {
                  if (!this.feeCalculatorFactory) {
                    throw new Error('Fee calculator factory not available');
                  }

                  const feeCalculator =
                    this.feeCalculatorFactory.getCalculator('solana');

                  if (!feeCalculator) {
                    throw new Error('Solana fee calculator not available');
                  }

                  // Calculate full-balance adjustment to get accurate fee breakdown
                  const feeBreakdown =
                    await feeCalculator.calculateFullBalanceAdjustment(
                      sellAmount.toString(),
                      true, // isFullBalance = true to get max fees
                      {
                        walletPublicKey: context.request.userWallet,
                        computeUnits: 400000, // Conservative estimate
                        priorityFeeMicroLamports: 1000, // Standard priority
                      },
                    );

                  // Use the total reserved amount as gas buffer
                  gasBuffer = BigInt(feeBreakdown.reserved);

                  this.logger.debug('Using Solana fee calculator for buffer', {
                    signatureFee: feeBreakdown.breakdown.other?.signatureFee,
                    computeFee: feeBreakdown.breakdown.other?.computeBudgetFee,
                    rentReserve: feeBreakdown.breakdown.rentReserve,
                    safetyBuffer: feeBreakdown.breakdown.safetyBuffer,
                    totalReserved: feeBreakdown.reserved,
                    gasBuffer: gasBuffer.toString(),
                  });
                } catch (error) {
                  // Fallback for Solana: Use conservative fixed fee (~0.002 SOL)
                  // Signature (5000) + Compute (~100k) + Rent (890k) + Buffer (50k) ≈ 1,045,000 lamports
                  gasBuffer = BigInt(2000000); // 0.002 SOL (conservative)
                  this.logger.warn(
                    'Solana fee calculator failed, using conservative fixed fee',
                    {
                      error: error.message,
                      fallbackBuffer: gasBuffer.toString(),
                      fallbackSOL: '0.002',
                    },
                  );
                }
              } else if (sourceEcosystem === 'tron') {
                // TRON: Use fixed fee structure (bandwidth + energy)
                // Typical TRX transfer: ~0.1-1 TRX depending on bandwidth/energy
                try {
                  if (!this.feeCalculatorFactory) {
                    throw new Error('Fee calculator factory not available');
                  }

                  const feeCalculator =
                    this.feeCalculatorFactory.getCalculator('tron');

                  if (!feeCalculator) {
                    throw new Error('Tron fee calculator not available');
                  }

                  const feeBreakdown =
                    await feeCalculator.calculateFullBalanceAdjustment(
                      sellAmount.toString(),
                      true,
                      {
                        walletAddress: context.request.userWallet,
                      },
                    );

                  gasBuffer = BigInt(feeBreakdown.reserved);

                  this.logger.debug('Using Tron fee calculator for buffer', {
                    totalReserved: feeBreakdown.reserved,
                    gasBuffer: gasBuffer.toString(),
                  });
                } catch (error) {
                  // Fallback for Tron: Conservative 1 TRX (1,000,000 sun)
                  gasBuffer = BigInt(1000000); // 1 TRX
                  this.logger.warn(
                    'Tron fee calculator failed, using conservative fixed fee',
                    {
                      error: error.message,
                      fallbackBuffer: gasBuffer.toString(),
                      fallbackTRX: '1',
                    },
                  );
                }
              } else if (sourceEcosystem === 'bitcoin') {
                // BITCOIN: Use dynamic fee calculation based on transaction size and fee rate
                try {
                  if (!this.feeCalculatorFactory) {
                    throw new Error('Fee calculator factory not available');
                  }

                  const feeCalculator =
                    this.feeCalculatorFactory.getCalculator('bitcoin');

                  if (!feeCalculator) {
                    throw new Error('Bitcoin fee calculator not available');
                  }

                  // Calculate Bitcoin fees dynamically
                  // Fee rate can be obtained from Bitcoin network APIs (mempool.space, blockchain.info)
                  // For now, use conservative 20 sat/vByte
                  const feeBreakdown =
                    await feeCalculator.calculateFullBalanceAdjustment(
                      sellAmount.toString(),
                      true,
                      {
                        feeRate: '20', // Conservative: 20 sat/vByte (can be dynamic from network)
                        inputCount: 1,
                        outputCount: 2,
                      },
                    );

                  gasBuffer = BigInt(feeBreakdown.reserved);

                  this.logger.debug('Using Bitcoin fee calculator for buffer', {
                    transactionFee: feeBreakdown.breakdown.transactionFee,
                    safetyBuffer: feeBreakdown.breakdown.safetyBuffer,
                    totalReserved: feeBreakdown.reserved,
                    gasBuffer: gasBuffer.toString(),
                  });
                } catch (error) {
                  // Fallback for Bitcoin: Use conservative fixed fee
                  // 0.001 BTC = 100,000 satoshis (covers most transactions)
                  gasBuffer = BigInt(100000);
                  this.logger.warn(
                    'Bitcoin fee calculator failed, using conservative fixed fee',
                    {
                      error: error.message,
                      fallbackBuffer: gasBuffer.toString(),
                      fallbackBTC: '0.001',
                    },
                  );
                }
              } else {
                // EVM: Use dynamic gas estimation
                // First try to use gas data from swap quote (already estimated by provider)
                const gasLimit = (() => {
                  const gl = swapQuote.gas || (swapQuote as any).estimatedGas;
                  return gl ? BigInt(gl) : 0n;
                })();

                let gasPrice: bigint | undefined;
                if (swapQuote.maxFeePerGas) {
                  gasPrice = BigInt(swapQuote.maxFeePerGas);
                } else if (swapQuote.gasPrice) {
                  gasPrice = BigInt(swapQuote.gasPrice);
                }

                // If quote has gas data, use it; otherwise estimate
                if (gasLimit > 0n && gasPrice !== undefined) {
                  const gasCost = gasLimit * gasPrice;
                  gasBuffer = (gasCost * 12n) / 10n; // 1.2x = 20% margin (consistent with EVM validation)

                  this.logger.debug('Using gas buffer from EVM quote', {
                    gasLimit: gasLimit.toString(),
                    gasPrice: gasPrice.toString(),
                    gasCost: gasCost.toString(),
                    gasBuffer: gasBuffer.toString(),
                  });
                } else {
                  // Fallback: estimate gas if not in quote
                  try {
                    const estimatedGas = await this.walletService.estimateGas(
                      sourceChainId,
                      context.request.userWallet,
                      swapQuote.to || context.request.userWallet,
                      swapQuote.data || '0x',
                      sellAmount.toString(),
                      'evm',
                    );

                    const feeData = await this.walletService.estimateFees(
                      sourceChainId,
                      'evm',
                    );

                    const estimatedGasPrice =
                      feeData.type === 'eip1559'
                        ? BigInt(feeData.maxFeePerGas)
                        : BigInt(feeData.gasPrice);

                    const gasCost = BigInt(estimatedGas) * estimatedGasPrice;
                    gasBuffer = (gasCost * 12n) / 10n; // 1.2x = 20% margin

                    this.logger.debug(
                      'Estimated EVM gas buffer (quote missing gas data)',
                      {
                        estimatedGas,
                        gasPrice: estimatedGasPrice.toString(),
                        gasCost: gasCost.toString(),
                        gasBuffer: gasBuffer.toString(),
                      },
                    );
                  } catch (error) {
                    // Final fallback for EVM: Use 1% of sell amount
                    // This is acceptable for EVM chains where gas costs can be significant
                    gasBuffer = (sellAmount * 1n) / 100n;
                    this.logger.warn(
                      'EVM gas estimation failed, using 1% of amount as fallback',
                      {
                        error: error.message,
                        fallbackBuffer: gasBuffer.toString(),
                        ecosystem: sourceEcosystem,
                      },
                    );
                  }
                }
              }
            }

            const requiredBalance = sellAmount + gasBuffer;

            this.logger.debug('Balance check', {
              balance: balance.toString(),
              required: requiredBalance.toString(),
              sellAmount: sellAmount.toString(),
              gasBuffer: gasBuffer.toString(),
              hasEnough: balance >= requiredBalance,
              swapFullBalance,
            });

            // For native tokens, also allow if balance equals sellAmount (full balance scenario)
            // preExecute() will adjust the amount if needed
            const isFullBalanceScenario = isNative && balance === sellAmount;

            if (balance < requiredBalance && !isFullBalanceScenario) {
              const formattedBalance = (
                Number(balance) / Math.pow(10, balanceInfo.decimals)
              ).toFixed(balanceInfo.decimals);
              const formattedRequired = (
                Number(sellAmount) / Math.pow(10, balanceInfo.decimals)
              ).toFixed(balanceInfo.decimals);
              const formattedGasBuffer = isNative
                ? (
                    Number(gasBuffer) / Math.pow(10, balanceInfo.decimals)
                  ).toFixed(balanceInfo.decimals)
                : '0';

              // Determine ecosystem-specific fee description for error message
              const sourceEcosystem = this.detectEcosystem(sourceChainId);
              let feeDescription = '';

              if (isNative && gasBuffer > 0n) {
                if (sourceEcosystem === 'solana') {
                  feeDescription = ` + ${formattedGasBuffer} ${balanceInfo.symbol} (Solana fees: signature + compute + rent)`;
                } else if (sourceEcosystem === 'tron') {
                  feeDescription = ` + ${formattedGasBuffer} ${balanceInfo.symbol} (Tron fees: bandwidth + energy)`;
                } else if (sourceEcosystem === 'bitcoin') {
                  feeDescription = ` + ${formattedGasBuffer} ${balanceInfo.symbol} (Bitcoin transaction fee)`;
                } else {
                  // EVM chains
                  feeDescription = ` + ${formattedGasBuffer} ${balanceInfo.symbol} (gas buffer with 20% margin)`;
                }
              }

              errors.push(
                `Insufficient balance on source chain ${sourceChainId}: have ${formattedBalance} ${balanceInfo.symbol}, ` +
                  `need ${formattedRequired} ${balanceInfo.symbol}${feeDescription}`,
              );

              this.logger.error(' Insufficient balance on source chain', {
                chain: sourceChainId,
                token: balanceInfo.symbol,
                balance: formattedBalance,
                required: formattedRequired,
                gasBuffer: formattedGasBuffer,
                gasIncluded: isNative,
                ecosystem: sourceEcosystem,
                feeDescription: feeDescription.trim(),
              });
            } else {
              if (isFullBalanceScenario) {
                this.logger.log(
                  ' Full balance swap detected - amount will be adjusted in preExecute()',
                  {
                    chain: sourceChainId,
                    token: balanceInfo.symbol,
                    balance: (
                      Number(balance) / Math.pow(10, balanceInfo.decimals)
                    ).toFixed(4),
                  },
                );
              } else {
                this.logger.log(' Source chain balance sufficient', {
                  chain: sourceChainId,
                  token: balanceInfo.symbol,
                  balance: (
                    Number(balance) / Math.pow(10, balanceInfo.decimals)
                  ).toFixed(4),
                });
              }
            }
          }
        } catch (balanceError) {
          errors.push(
            `Source chain balance check failed: ${balanceError.message}`,
          );
          this.logger.error('Balance validation error', {
            error: balanceError.message,
            stack: balanceError.stack,
          });
        }
      }

      // ============================================================================
      // 7. VALIDATE DESTINATION CHAIN ADDRESS
      // ============================================================================
      this.logger.log(' Validating destination chain address...');

      const destChainId = normalizeChainId(destStep.chainId);

      // Detect destination ecosystem based on chainId (multi-chain support)
      const destEcosystem = this.detectEcosystem(destChainId);
      this.logger.debug('Destination ecosystem detected', {
        chain: destChainId,
        ecosystem: destEcosystem,
      });
      try {
        // Basic address format validation
        if (destEcosystem === 'evm') {
          // EVM address validation
          if (!recipient || !recipient.match(/^0x[a-fA-F0-9]{40}$/)) {
            errors.push('Invalid EVM address format for destination chain');
            this.logger.error(' Invalid EVM address', {
              address: recipient,
              chain: destChainId,
            });
          } else {
            this.logger.debug(' EVM address format valid for destination', {
              address: recipient,
              chain: destChainId,
            });
          }
        } else if (destEcosystem === 'solana') {
          // Solana address validation (32-44 base58 characters)
          if (!recipient || recipient.length < 32 || recipient.length > 44) {
            errors.push('Invalid Solana address format for destination chain');
            this.logger.error(' Invalid Solana address', {
              address: recipient,
              chain: destChainId,
            });
          } else {
            this.logger.debug(' Solana address format valid for destination', {
              address: recipient,
              chain: destChainId,
            });
          }
        }
      } catch (addrError) {
        this.logger.warn(' Address validation warning', {
          error: addrError.message,
        });
      }

      // ============================================================================
      // 8. VALIDATE PRICE IMPACT
      // ============================================================================
      this.logger.log(' Validating price impact...');

      if (swapQuote.priceImpact) {
        const priceImpact = parseFloat(swapQuote.priceImpact);

        if (!isNaN(priceImpact)) {
          this.logger.debug('Price impact', {
            impact: `${priceImpact.toFixed(2)}%`,
          });

          if (priceImpact > 15) {
            errors.push(
              `Extreme price impact: ${priceImpact.toFixed(2)}%. ` +
                `This indicates insufficient liquidity. Consider reducing amount or trying a different route.`,
            );
            this.logger.error(' Extreme price impact detected', {
              impact: `${priceImpact.toFixed(2)}%`,
            });
          } else if (priceImpact > 5) {
            this.logger.warn(' High price impact', {
              impact: `${priceImpact.toFixed(2)}%`,
            });
          } else if (priceImpact > 2) {
            this.logger.log(' Moderate price impact', {
              impact: `${priceImpact.toFixed(2)}%`,
            });
          } else {
            this.logger.log(' Price impact acceptable', {
              impact: `${priceImpact.toFixed(2)}%`,
            });
          }
        }
      } else {
        this.logger.debug('No price impact data available');
      }

      // ============================================================================
      // 9. VALIDATE GAS ESTIMATION
      // ============================================================================
      this.logger.log(' Validating gas estimation...');

      if (!swapQuote.gas && !swapQuote.estimatedGas) {
        this.logger.warn(
          ' No gas estimation provided - will use default during execution',
        );
      } else {
        const gasEstimate = swapQuote.gas || swapQuote.estimatedGas;

        if (gasEstimate) {
          const gasNum = parseInt(gasEstimate);

          this.logger.debug('Gas estimate', { gas: gasEstimate });

          // Cross-chain swaps typically use more gas than regular swaps
          // Warn if gas seems unusually high or low
          if (gasNum < 50000) {
            this.logger.warn(' Gas estimate seems low for cross-chain swap', {
              gas: gasEstimate,
            });
          } else if (gasNum > 2000000) {
            this.logger.warn(' Gas estimate very high', { gas: gasEstimate });
          } else {
            this.logger.log(' Gas estimation present', { gas: gasEstimate });
          }
        }
      }

      // ============================================================================
      // 10. VALIDATE BRIDGE PROTOCOL SPECIFIC REQUIREMENTS
      // ============================================================================
      this.logger.log(' Validating bridge protocol requirements...');

      const aggregator = swapQuote.aggregator;

      if (aggregator === AggregatorType.RUBIC) {
        // Rubic-specific validation
        this.logger.debug('Validating Rubic bridge requirements');

        // Check for allowanceTarget (approval address)
        if (!swapQuote.allowanceTarget && !isNativeToken(sellTokenAddress)) {
          this.logger.warn(
            ' No allowanceTarget specified for Rubic - may need approval',
          );
        }

        // Rubic requires specific transaction structure
        const rubicRef = route.providerRef as any;
        if (rubicRef.providerType) {
          this.logger.debug('Rubic provider type', {
            providerType: rubicRef.providerType,
          });
        }

        if (rubicRef.useRubicContract !== undefined) {
          this.logger.debug('Rubic contract usage', {
            useRubicContract: rubicRef.useRubicContract,
          });
        }
      } else if (aggregator === AggregatorType.SOCKET) {
        // Socket-specific validation
        this.logger.debug('Validating Socket bridge requirements');
        // Socket requires userTxs array in route
      } else if (aggregator === AggregatorType.RANGO) {
        // Rango-specific validation
        this.logger.debug('Validating Rango bridge requirements');
        // Rango has its own transaction structure
      } else {
        this.logger.debug('Generic bridge validation', { aggregator });
      }

      // ============================================================================
      // 11. VALIDATE APPROVAL REQUIREMENTS
      // ============================================================================
      this.logger.log(' Validating approval requirements...');

      // Skip approval validation for deposit-based trades (CEX)
      // Deposit trades are simple native transfers, no smart contract approvals needed
      if (isDepositBasedTrade) {
        this.logger.debug(
          ' Deposit-based trade - no approval validation needed (simple transfer)',
        );
      } else if (sellTokenAddress && !isNativeToken(sellTokenAddress)) {
        const bridgeContract = swapQuote.allowanceTarget || swapQuote.to;

        if (!bridgeContract) {
          this.logger.warn(
            ' No approval target specified - may cause execution failure',
          );
        } else {
          this.logger.debug('Approval target identified', {
            target: bridgeContract,
          });

          // Note: Actual approval check is done in preExecute, we just validate the target exists
          try {
            const sourceChainId = route.steps?.[0]?.chainId;
            const sourceEcosystem = sourceChainId
              ? detectEcosystemFromChainId(sourceChainId)
              : 'evm';

            // Solana/Bitcoin do not use ERC20-style approvals. The swap tx itself
            // (or program instruction) authorizes token movement.
            if (sourceEcosystem === 'solana' || sourceEcosystem === 'bitcoin') {
              this.logger.debug(
                `Skipping approval target format validation for ecosystem: ${sourceEcosystem}`,
              );
            } else {
              const isEvmAddress =
                typeof bridgeContract === 'string' &&
                /^0x[a-fA-F0-9]{40}$/.test(bridgeContract);
              const isTronBase58Address =
                typeof bridgeContract === 'string' &&
                bridgeContract.startsWith('T') &&
                bridgeContract.length === 34;

              if (!isEvmAddress && !isTronBase58Address) {
                errors.push('Invalid approval target address format');
                this.logger.error(' Invalid approval target', {
                  target: bridgeContract,
                });
              } else {
                this.logger.log(' Valid approval target address');
              }
            }
          } catch (approvalError) {
            this.logger.warn(' Approval target validation warning', {
              error: approvalError.message,
            });
          }
        }
      } else if (sellTokenAddress && isNativeToken(sellTokenAddress)) {
        this.logger.debug('Native token - no approval needed');
      }

      // ============================================================================
      // 12. VALIDATE FEE STRUCTURE
      // ============================================================================
      this.logger.log(' Validating fee structure...');

      if (route.fees) {
        const { gas, provider, bridge, app } = route.fees;
        const sellTokenDecimals = this.resolveSellTokenDecimals(
          route,
          swapQuote,
        );
        const sellAmountBaseUnits = this.convertAmountStringToBaseUnits(
          swapQuote.sellAmount,
          sellTokenDecimals,
        );

        this.logger.debug('Fee breakdown', {
          gas: gas || '0',
          provider: provider || '0',
          bridge: bridge || '0',
          app: app || '0',
        });

        if (provider && sellAmountBaseUnits > 0n) {
          const providerAmount = this.convertAmountStringToBaseUnits(
            provider,
            sellTokenDecimals,
          );
          if (providerAmount > sellAmountBaseUnits / 100n) {
            const providerPercentageBps =
              (providerAmount * 10000n) / sellAmountBaseUnits;
            const providerPercentage = (
              Number(providerPercentageBps) / 100
            ).toFixed(2);
            this.logger.warn(' Provider fee seems high', {
              fee: provider,
              sellAmount: swapQuote.sellAmount,
              percentage: `${providerPercentage}%`,
            });
          }
        }

        if (bridge && sellAmountBaseUnits > 0n) {
          const bridgeAmount = this.convertAmountStringToBaseUnits(
            bridge,
            sellTokenDecimals,
          );
          if (bridgeAmount > sellAmountBaseUnits / 100n) {
            const bridgePercentageBps =
              (bridgeAmount * 10000n) / sellAmountBaseUnits;
            const bridgePercentage = (
              Number(bridgePercentageBps) / 100
            ).toFixed(2);
            this.logger.warn(' Bridge fee seems high', {
              fee: bridge,
              sellAmount: swapQuote.sellAmount,
              percentage: `${bridgePercentage}%`,
            });
          }
        }
      } else {
        this.logger.debug('No detailed fee breakdown available');
      }

      // ============================================================================
      // VALIDATION SUMMARY
      // ============================================================================

      if (errors.length === 0) {
        this.logger.log(' All cross-chain validations passed successfully');
        this.logger.debug('Validation summary', {
          route: `${sourceChainId} → ${destChainId}`,
          steps: route.steps.length,
          aggregator: swapQuote.aggregator,
          sellToken: sellTokenAddress,
          buyToken: swapQuote.buyToken,
        });
      } else {
        this.logger.error(' Cross-chain validation failed', {
          errorCount: errors.length,
          errors: errors.join('; '),
        });
      }
    } catch (error) {
      errors.push(`Cross-chain validation error: ${error.message}`);
      this.logger.error('Cross-chain validation exception', {
        error: error.message,
        stack: error.stack,
      });
    }

    return errors;
  }

  /**
   * Pre-execution setup for cross-chain swaps
   * Handles approvals on source chain
   * Calls base preExecute first to handle native token amount adjustment
   */
  protected async preExecute(context: ExecutionContext): Promise<void> {
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;

    // Winston logging: Log selected route before adjustment
    this.logger.log(
      `Starting cross-chain pre-execution with selected route: ${context.request.routeId}`,
      JSON.stringify({
        routeId: context.request.routeId,
        routeProvider: swapQuote?.aggregator || 'unknown',
        routeSteps: route.steps?.length || 0,
        sourceChain: route.steps?.[0]?.chainId,
        destinationChain: route.steps?.[route.steps.length - 1]?.chainId,
        originalAmount: swapQuote?.sellAmount || swapQuote?.value || '0',
        originalOutputAmount: route.totalEstimatedOut || '0',
        routeGasLimit:
          route.fees?.gas && route.fees.gas !== '0'
            ? route.fees.gas
            : 'unknown',
        routeGasCostWei:
          route.fees?.gasCostWei && route.fees.gasCostWei !== '0'
            ? route.fees.gasCostWei
            : 'unknown',
        routeGasPrice:
          route.fees?.gasPrice && route.fees.gasPrice !== '0'
            ? route.fees.gasPrice
            : 'unknown',
        swapFullBalance: context.request.swapFullBalance || false,
      }),
    );

    // Call base preExecute first to handle native token balance adjustment
    await super.preExecute(context);

    if (context.request.amountAdjustment) {
      const adjustment = context.request.amountAdjustment;
      const balanceBigInt = BigInt(adjustment.originalAmount || '0');
      const adjustedBigInt = BigInt(adjustment.adjustedAmount || '0');
      const actualReserved = balanceBigInt - adjustedBigInt;

      this.logger.log(
        `Amount adjustment completed for cross-chain swap: ${context.request.routeId}`,
        JSON.stringify({
          routeId: context.request.routeId,
          routeProvider: swapQuote?.aggregator || 'unknown',
          originalAmount: adjustment.originalAmount,
          adjustedAmount: adjustment.adjustedAmount,
          reserved: actualReserved.toString(),
          feeBreakdown: adjustment.feeBreakdown,
          gasCost: adjustment.gasCost,
          gasLimit: adjustment.gasLimit,
          reason: adjustment.reason,
          originalOutputAmount: adjustment.originalOutputAmount,
          adjustedOutputAmount: adjustment.adjustedOutputAmount,
          calculationMethod: adjustment.feeBreakdown
            ? 'fee-calculator'
            : 'fallback',
        }),
      );
    }

    this.logger.debug('Starting cross-chain pre-execution checks');

    if (swapQuote.priceImpact) {
      const priceImpact = parseFloat(swapQuote.priceImpact);

      if (!isNaN(priceImpact)) {
        if (priceImpact > 10) {
          this.logger.error(
            `🚨 EXTREME PRICE IMPACT: ${priceImpact.toFixed(2)}%`,
            {
              aggregator: swapQuote.aggregator,
              priceImpact: `${priceImpact.toFixed(2)}%`,
            },
          );
        } else if (priceImpact > 5) {
          this.logger.warn(` HIGH PRICE IMPACT: ${priceImpact.toFixed(2)}%`);
        }
      }
    }

    const sourceChainId = route.steps[0].chainId;
    const sourceToken =
      swapQuote.sellToken || route.steps[0].details?.fromToken;
    const bridgeContract = swapQuote.allowanceTarget;

    if (!sourceToken) {
      this.logger.warn(
        ' No source token address found - skipping approval check',
      );
      this.logger.debug(' Cross-chain pre-execution checks complete');
      return;
    }

    if (isNativeToken(sourceToken)) {
      this.logger.debug('Native token - no approval needed');
      this.logger.debug(' Cross-chain pre-execution checks complete');
      return;
    }

    if (typeof sourceChainId === 'string' && isNaN(Number(sourceChainId))) {
      this.logger.debug(
        `Non-numeric chain (${sourceChainId}) - skipping approval check`,
      );
      this.logger.debug(' Cross-chain pre-execution checks complete');
      return;
    }

    // Check if approval is needed
    if (!bridgeContract) {
      this.logger.warn(
        ' No allowance target specified - skipping approval check',
      );
      this.logger.debug(' Cross-chain pre-execution checks complete');
      return;
    }

    try {
      // Convert chainId to number for approval service
      const numericChainId =
        typeof sourceChainId === 'string'
          ? parseInt(sourceChainId)
          : sourceChainId;

      const ecosystem = detectEcosystemFromChainId(numericChainId);

      // Solana/Bitcoin do not use ERC20-style approvals.
      // If we ever see these here, skip instead of failing with EVM address validators.
      if (ecosystem === 'solana' || ecosystem === 'bitcoin') {
        this.logger.debug(
          `Skipping approval check for ecosystem without allowances: ${ecosystem}`,
          {
            chainId: sourceChainId,
            token: sourceToken,
            allowanceTarget: bridgeContract,
          },
        );
        this.logger.debug(' Cross-chain pre-execution checks complete');
        return;
      }

      this.logger.debug('Checking approval status for bridge contract', {
        chainId: sourceChainId,
        numericChainId,
        token: sourceToken,
        bridge: bridgeContract,
        amount: swapQuote.sellAmount,
      });

      // Check if approval is needed
      const approvalNeeded = await this.approvalService.isApprovalNeeded(
        numericChainId,
        sourceToken,
        context.request.userWallet,
        bridgeContract,
        swapQuote.sellAmount,
      );

      if (!approvalNeeded) {
        this.logger.debug(' Token already approved for bridge contract');
        this.logger.debug(' Cross-chain pre-execution checks complete');
        return;
      }

      this.logger.log(' Approval required for bridge contract', {
        chainId: sourceChainId,
        token: sourceToken,
        bridge: bridgeContract,
      });

      // Execute approval transaction
      this.logger.log('Executing approval transaction for bridge...');

      const approvalResult = await this.approvalService.executeApproval(
        numericChainId,
        context.request.privateKey,
        sourceToken,
        bridgeContract,
        swapQuote.sellAmount, // ApprovalService executes MaxUint256 approval
      );

      this.logger.log(
        ` Approval transaction sent: ${approvalResult.transactionHash}`,
      );

      // Wait for approval confirmation
      // - EVM: 2 block confirmations
      // - Tron: 1 confirmation (fast blocks, different semantics)
      const confirmations = ecosystem === 'tron' ? 1 : 2;
      this.logger.log(
        `Waiting for approval confirmation (${confirmations})...`,
      );
      await this.walletService.waitForTransactionConfirmation(
        sourceChainId,
        approvalResult.transactionHash,
        confirmations,
        ecosystem,
      );

      this.logger.log(' Approval confirmed - ready for cross-chain swap');
      this.logger.debug(' Cross-chain pre-execution checks complete');
    } catch (approvalError) {
      this.logger.error(' Approval failed', {
        error: approvalError.message,
        chainId: sourceChainId,
        token: sourceToken,
      });
      throw new Error(
        `Approval failed for cross-chain swap: ${approvalError.message}`,
      );
    }
  }

  /**
   * Build cross-chain transaction data
   * Prepares transaction for source chain
   */
  protected async buildTransaction(context: ExecutionContext): Promise<{
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    functionSelector?: string;
    feeLimit?: string;
  }> {
    const route = context.request.route;
    const swapQuote = route.providerRef as any;
    const sourceStep = route.steps[0];
    const destStep = route.steps[route.steps.length - 1];
    const sourceEcosystem = this.detectEcosystem(sourceStep.chainId);

    // Detect ecosystems for transaction handling
    const isSolanaTransaction =
      swapQuote.isSolanaTransaction === true || sourceEcosystem === 'solana';
    const isTronTransaction = sourceEcosystem === 'tron';
    const isBitcoinTransaction = sourceEcosystem === 'bitcoin';
    const isEvmTransaction =
      !isSolanaTransaction && !isTronTransaction && !isBitcoinTransaction;

    this.logger.debug('Building cross-chain transaction for source chain', {
      aggregator: swapQuote.aggregator,
      sourceChain: sourceStep.chainId,
      destChain: route.steps[route.steps.length - 1].chainId,
      isSolana: isSolanaTransaction,
      blockchain: swapQuote.sourceBlockchain,
    });

    const sellTokenDecimals = this.resolveSellTokenDecimals(route, swapQuote);

    // Extract transaction data from cross-chain quote
    // Different bridge protocols have different formats:
    // - Rubic EVM: transaction object with to, data, value
    // - Rubic Solana: transaction object with data only (base64-encoded VersionedTransaction)
    // - Socket: route with userTxs array
    // - Stargate: Router contract call with specific params
    // All should be normalized in SwapQuote format

    // Validate required fields based on blockchain type
    if (isSolanaTransaction) {
      // Check if this is a deposit-based trade (CEX) FIRST
      const depositInfo = swapQuote.depositInfo;

      if (depositInfo && depositInfo.transferEcosystem === 'solana') {
        // CEX deposit trade on Solana: use depositInfo structure for simple native transfer
        this.logger.debug('🔷 Solana CEX deposit transaction detected', {
          depositAddress: depositInfo.depositAddress,
          amount: depositInfo.amountToSendDecimal,
          exchangeId: depositInfo.exchangeId,
          providerType: depositInfo.providerType,
          note: 'Simple native SOL transfer to CEX deposit address',
        });

        // CRITICAL: Pass swapFullBalance flag and token address via gasLimit JSON
        // This allows the Solana wallet provider to properly reserve rent-exempt minimum
        // and transaction fees when swapping the full balance
        const sellTokenAddress =
          swapQuote.sellToken ||
          sourceStep.details?.fromToken ||
          'So11111111111111111111111111111111111111111'; // Default to native SOL
        const gasLimitData = JSON.stringify({
          swapFullBalance: context.request.swapFullBalance || false,
          tokenAddress: sellTokenAddress,
        });

        return {
          to: depositInfo.depositAddress, // Solana deposit address
          data: '', // Native SOL transfer, no transaction data
          value: depositInfo.transferValue, // Amount in lamports (atomic units)
          gasLimit: gasLimitData, // Pass flags to wallet provider
        };
      }

      // Not a CEX deposit - regular Solana swap requiring base64 transaction
      // Solana: Only requires data field (base64-encoded serialized transaction)
      if (!swapQuote.data) {
        throw new Error(
          'Missing transaction data (base64) in Solana swap quote',
        );
      }

      this.logger.debug(
        ' Solana transaction detected - base64 encoded VersionedTransaction',
        {
          dataLength: swapQuote.data.length,
          blockchain: swapQuote.sourceBlockchain,
        },
      );

      // Return Solana transaction format
      // Note: Solana transactions need special handling in sendTransaction
      return {
        to: '', // Not used for Solana bridge transactions
        data: swapQuote.data, // Base64-encoded VersionedTransaction
        value: '0', // Not used for Solana
        gasLimit: undefined, // Solana uses compute units, not gas
      };
    }

    // Tron native transfers (deposit trades) do not provide data payload
    if (isTronTransaction) {
      // Check if this is a deposit-based trade (CEX)
      const depositInfo = swapQuote.depositInfo;

      if (depositInfo && depositInfo.transferEcosystem === 'tron') {
        // Get sell token address to determine if it's TRC20 or native TRX
        const sellToken =
          swapQuote.sellToken || route.steps?.[0]?.details?.fromToken;
        const isNativeTrx = !sellToken || isNativeToken(sellToken);

        if (isNativeTrx) {
          // Native TRX transfer
          this.logger.debug(
            ' Tron CEX deposit transaction detected (native TRX)',
            {
              depositAddress: depositInfo.depositAddress,
              amount: depositInfo.amountToSendDecimal,
              exchangeId: depositInfo.exchangeId,
              providerType: depositInfo.providerType,
            },
          );

          return {
            to: depositInfo.depositAddress,
            data: '', // Native TRX transfer, no contract data
            value: depositInfo.transferValue, // TRX amount
            gasLimit: undefined, // Tron uses energy/bandwidth model
          };
        } else {
          // TRC20 token transfer - use special marker for wallet provider to handle
          // The wallet provider will encode the transfer(address,uint256) call
          this.logger.debug(
            ' Tron CEX deposit transaction detected (TRC20 token)',
            {
              depositAddress: depositInfo.depositAddress,
              tokenAddress: sellToken,
              amount: depositInfo.amountToSendDecimal,
              transferValue: depositInfo.transferValue,
              exchangeId: depositInfo.exchangeId,
              providerType: depositInfo.providerType,
              note: 'Will use TRC20 transfer function via wallet provider',
            },
          );

          // For TRC20 transfers, we pass metadata to the wallet provider
          // The wallet provider will recognize this pattern and encode the transfer call
          return {
            to: sellToken, // Token contract address
            data: 'TRC20_TRANSFER', // Special marker for wallet provider
            value: depositInfo.transferValue, // Amount to transfer (in atomic units)
            gasLimit: JSON.stringify({
              // Pass deposit address via gasLimit metadata
              trc20Transfer: {
                recipient: depositInfo.depositAddress,
                amount: depositInfo.transferValue,
              },
            }),
          };
        }
      } else {
        // Direct Tron swap (not CEX)
        if (!swapQuote.to) {
          throw new Error('Missing destination address in Tron swap quote');
        }

        if (!swapQuote.value) {
          throw new Error('Missing transaction value in Tron swap quote');
        }

        this.logger.debug(' Tron direct swap transaction detected', {
          to: swapQuote.to,
          value: swapQuote.value,
          dataProvided: !!swapQuote.data,
          hasFunctionSelector: !!swapQuote.functionSelector,
          hasFeeLimit: !!swapQuote.feeLimit,
        });

        return {
          to: swapQuote.to,
          data: swapQuote.data || '', // Tron native transfers usually have empty data
          value: swapQuote.value,
          gasLimit: undefined,
          functionSelector: swapQuote.functionSelector, // Pass through Symbiosis function selector
          feeLimit: swapQuote.feeLimit, // Pass through Symbiosis fee limit
        };
      }
    }

    // Bitcoin native transfers (deposit trades typically for CEX)
    if (isBitcoinTransaction) {
      // Check if this is a deposit-based trade (CEX)
      const depositInfo = swapQuote.depositInfo;

      if (depositInfo && depositInfo.transferEcosystem === 'bitcoin') {
        // CEX deposit trade: use depositInfo structure
        this.logger.debug(' Bitcoin CEX deposit transaction detected', {
          depositAddress: depositInfo.depositAddress,
          amount: depositInfo.amountToSendDecimal,
          exchangeId: depositInfo.exchangeId,
          providerType: depositInfo.providerType,
        });

        return {
          to: depositInfo.depositAddress,
          data: '', // Bitcoin doesn't have smart contracts, no data field
          value: depositInfo.transferValue, // BTC amount in satoshis
          gasLimit: undefined, // Bitcoin uses UTXO model, fees calculated differently
        };
      } else {
        // Direct Bitcoin swap (not CEX) - unlikely but handle gracefully
        if (!swapQuote.to) {
          throw new Error('Missing destination address in Bitcoin swap quote');
        }

        if (!swapQuote.value) {
          throw new Error('Missing transaction value in Bitcoin swap quote');
        }

        this.logger.debug(' Bitcoin direct transaction detected', {
          to: swapQuote.to,
          value: swapQuote.value,
        });

        return {
          to: swapQuote.to,
          data: '', // Bitcoin doesn't support data field
          value: swapQuote.value,
          gasLimit: undefined,
        };
      }
    }

    // EVM chains: Check if this is a deposit-based trade (CEX) first
    const depositInfo = swapQuote.depositInfo;

    if (depositInfo && depositInfo.transferEcosystem === 'evm') {
      // CEX deposit trade on EVM: use depositInfo structure for simple native transfer
      this.logger.debug('🏦 EVM CEX deposit transaction detected', {
        depositAddress: depositInfo.depositAddress,
        amount: depositInfo.amountToSendDecimal,
        exchangeId: depositInfo.exchangeId,
        providerType: depositInfo.providerType,
        note: 'Simple native token transfer to CEX deposit address',
      });

      return {
        to: depositInfo.depositAddress,
        data: '0x', // Native ETH/BNB/etc transfer, no contract data
        value: depositInfo.transferValue, // Amount in wei (atomic units)
        gasLimit: depositInfo.raw?.gasLimit?.toString() || undefined,
      };
    }

    // EVM validation: requires to, data fields (for non-deposit trades)
    if (!swapQuote.to) {
      throw new Error(
        'Missing destination address (bridge contract) in EVM swap quote',
      );
    }

    if (!swapQuote.data) {
      throw new Error('Missing transaction data in EVM swap quote');
    }

    // Extract value - for native token swaps, use value field; otherwise use sellAmount
    // After amount adjustment, the new quote should have updated value
    let txValue = swapQuote.value || '0';

    // CRITICAL: If we have an amount adjustment, use the quote's sellAmount/value as the transaction value
    // The transaction data (swapQuote.data) is built for the quote's sellAmount, so value MUST match
    // The refinement loop ensures the quote's sellAmount fits within balance limits
    if (context.request.amountAdjustment && swapQuote.sellToken) {
      const isNative = isNativeToken(swapQuote.sellToken);
      if (isNative) {
        // Use quote's sellAmount/value (the transaction.data is built for this amount)
        txValue =
          swapQuote.sellAmount ||
          swapQuote.value ||
          context.request.amountAdjustment.adjustedAmount;

        this.logger.log('Using quote amount for native token transaction', {
          originalValue: context.request.amountAdjustment.originalAmount,
          quoteSellAmount: swapQuote.sellAmount,
          quoteValue: swapQuote.value,
          adjustedAmount: context.request.amountAdjustment.adjustedAmount,
          txValue,
          gasCost: context.request.amountAdjustment.gasCost,
          reason: context.request.amountAdjustment.reason,
          note: 'Using quote sellAmount/value - refinement loop ensured it fits within balance',
        });
      }
    }

    const normalizedTxValue = isEvmTransaction
      ? this.convertAmountStringToBaseUnits(
          txValue,
          sellTokenDecimals,
        ).toString()
      : txValue;

    // Final validation: ensure transaction value doesn't exceed balance
    // This is a safety check to prevent sending more than available
    if (
      context.request.amountAdjustment &&
      swapQuote.sellToken &&
      isNativeToken(swapQuote.sellToken)
    ) {
      const balance = await this.getNativeTokenBalance(
        sourceStep.chainId,
        context.request.userWallet,
      );
      const txValueBigInt = this.convertAmountStringToBaseUnits(
        txValue,
        sellTokenDecimals,
      );
      const balanceBigInt = BigInt(balance);

      if (txValueBigInt > balanceBigInt) {
        this.logger.error(
          'Transaction value exceeds balance - this should not happen after adjustment',
          {
            txValue,
            balance,
            difference: (txValueBigInt - balanceBigInt).toString(),
            amountAdjustment: context.request.amountAdjustment,
          },
        );
        throw new Error(
          `Transaction value (${txValue}) exceeds available balance (${balance}). ` +
            `This indicates the amount adjustment did not work correctly.`,
        );
      }

      // Also verify that value + estimated gas doesn't exceed balance
      // CRITICAL: If we already have an amountAdjustment, use its gas cost instead of re-estimating
      // Re-estimating gas causes unnecessary network calls and potential variations
      // The adjustment was done in preExecute() and the quote's transaction data matches the adjusted amount
      let gasCostToUse: string;
      if (context.request.amountAdjustment?.gasCost) {
        // Use gas cost from amountAdjustment (already calculated in performAmountAdjustment)
        gasCostToUse = context.request.amountAdjustment.gasCost;
        this.logger.debug(
          'Using gas cost from amountAdjustment (avoiding re-estimation)',
          {
            gasCost: gasCostToUse,
            gasLimit: context.request.amountAdjustment.gasLimit,
            note: 'Gas cost was already calculated in performAmountAdjustment() - re-estimating would cause unnecessary variations',
          },
        );
      } else {
        // No amountAdjustment exists (non-full-balance swap) - estimate gas normally
        const estimatedGasCost = await this.estimateTransactionCost(context);
        gasCostToUse = estimatedGasCost.gasCost;
      }

      const totalRequired = txValueBigInt + BigInt(gasCostToUse);

      // CRITICAL: The buffer was already accounted for in performAmountAdjustment when calculating adjustedAmount
      // adjustedAmount = balance - gasCost - 100 wei buffer
      // This means: adjustedAmount + gasCost + 100 wei buffer = balance
      // Rubic may return txValue = adjustedAmount + rounding (0-100 wei)
      // So: txValue + gasCost = adjustedAmount + rounding + gasCost = balance - buffer + rounding
      // If rounding <= buffer (100 wei), then txValue + gasCost <= balance
      // We should NOT add the buffer again here - it was already subtracted from adjustedAmount
      // The check should be: txValue + gasCost <= balance (the buffer is already built into the calculation)

      if (totalRequired > balanceBigInt) {
        // Calculate the difference to see if it's within the expected rounding tolerance
        const difference = totalRequired - balanceBigInt;
        const rubicRoundingTolerance = BigInt(
          this.aggregatorTolerances.providers.rubic.roundingTolerance,
        );

        if (difference <= rubicRoundingTolerance) {
          // Difference is within expected Rubic rounding tolerance (0-100 wei)
          // This is acceptable - the buffer was designed to handle this
          this.logger.debug(
            'Transaction value + gas slightly exceeds balance (within Rubic rounding tolerance)',
            {
              txValue,
              quoteSellAmount: swapQuote.sellAmount,
              quoteValue: swapQuote.value,
              amountAdjustmentAdjustedAmount:
                context.request.amountAdjustment?.adjustedAmount,
              gasCost: gasCostToUse,
              totalRequired: totalRequired.toString(),
              balance,
              difference: difference.toString(),
              note: `Difference (${difference.toString()} wei) is within expected Rubic API rounding tolerance (100 wei). Buffer was already accounted for in adjustedAmount calculation.`,
            },
          );
        } else {
          // Difference exceeds tolerance - this indicates a real problem
          this.logger.error(
            'Transaction value + gas exceeds balance AFTER adjustment - exceeds rounding tolerance',
            {
              txValue,
              quoteSellAmount: swapQuote.sellAmount,
              quoteValue: swapQuote.value,
              amountAdjustmentAdjustedAmount:
                context.request.amountAdjustment?.adjustedAmount,
              gasCost: gasCostToUse,
              totalRequired: totalRequired.toString(),
              balance,
              difference: difference.toString(),
              roundingTolerance: rubicRoundingTolerance.toString(),
              note: 'Amount was already adjusted in preExecute(). Difference exceeds expected Rubic rounding tolerance.',
            },
          );

          // Throw error instead of silently recalculating and breaking the transaction
          throw new Error(
            `Transaction value (${txValue}) + gas (${gasCostToUse}) exceeds balance (${balance}) by ${difference.toString()} wei ` +
              `even after amount adjustment. This exceeds the expected Rubic rounding tolerance (100 wei). ` +
              `Original amount: ${context.request.amountAdjustment?.originalAmount}, ` +
              `Adjusted amount: ${context.request.amountAdjustment?.adjustedAmount}, ` +
              `Quote sellAmount: ${swapQuote.sellAmount}, Quote value: ${swapQuote.value}`,
          );
        }
      }
    }

    // CRITICAL: Prioritize network-estimated gas limit over Rubic's gas limit
    // Priority order:
    // 1. amountAdjustment.gasLimit (network-estimated, already accurate, no margin needed)
    // 2. Fresh network estimation (most accurate for current transaction data)
    // 3. Rubic's gas limit (fallback only, may be inaccurate placeholder)
    let gasLimit: string | undefined;

    if (context.request.amountAdjustment?.gasLimit) {
      // Use gas limit from amount adjustment (already includes 20% margin from conservative estimate or network estimation)
      gasLimit = context.request.amountAdjustment.gasLimit;
      this.logger.log('Using gas limit from amount adjustment', {
        gasLimit,
        source: 'amountAdjustment',
        note: 'Already includes appropriate margin (20% for conservative estimate or network estimation)',
      });
    } else if (isEvmTransaction) {
      // Try fresh network estimation with actual transaction data
      try {
        const estimated = await this.walletService.estimateGas(
          sourceStep.chainId,
          context.request.userWallet,
          swapQuote.to,
          swapQuote.data,
          normalizedTxValue,
          'evm',
        );
        const est = BigInt(estimated);
        // Use 2% margin (consistent with estimateTransactionCost) instead of 20%
        // Network estimation is already accurate, we just need a small buffer
        const withMargin = (est * 102n) / 100n; // 1.02x (2% safety margin)
        gasLimit = withMargin.toString();
        this.logger.log('Using fresh network-estimated gas limit', {
          estimated: estimated.toString(),
          gasLimit,
          margin: '2%',
          source: 'network-estimation',
        });
      } catch (e) {
        // Network estimation failed - log warning but continue to fallback
        this.logger.warn('Network gas estimation failed, will use fallback', {
          error: e.message,
          note: 'Will fallback to Rubic gas limit or conservative default',
        });
        // gasLimit remains undefined, will use fallback below
      }
    } else {
      this.logger.debug(
        'Skipping network gas estimation for non-EVM source chain',
        {
          sourceChain: sourceStep.chainId,
          ecosystem: sourceEcosystem,
        },
      );
    }

    const tx: any = {
      to: swapQuote.to,
      data: swapQuote.data,
      value: normalizedTxValue,
      gasLimit: gasLimit, // Network-estimated (if available), otherwise undefined for fallback
      gasPrice: undefined as string | undefined,
      maxFeePerGas: undefined as string | undefined,
      maxPriorityFeePerGas: undefined as string | undefined,
    };

    // Handle gas pricing (EIP-1559 or legacy); if missing, estimate via wallet service
    if (isEvmTransaction) {
      if (swapQuote.maxFeePerGas && swapQuote.maxPriorityFeePerGas) {
        tx.maxFeePerGas = swapQuote.maxFeePerGas;
        tx.maxPriorityFeePerGas = swapQuote.maxPriorityFeePerGas;
        this.logger.debug('Using EIP-1559 gas pricing from quote', {
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        });
      } else if (swapQuote.gasPrice) {
        tx.gasPrice = swapQuote.gasPrice;
        this.logger.debug('Using legacy gas pricing from quote', {
          gasPrice: tx.gasPrice,
        });
      } else {
        try {
          const feeData = await this.walletService.estimateFees(
            sourceStep.chainId,
            'evm',
          );
          if (feeData.type === 'eip1559') {
            tx.maxFeePerGas = feeData.maxFeePerGas;
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
            this.logger.debug(
              'Estimated EIP-1559 fees via wallet service',
              feeData,
            );
          } else {
            tx.gasPrice = feeData.gasPrice;
            this.logger.debug(
              'Estimated legacy gasPrice via wallet service',
              feeData,
            );
          }
        } catch (e) {
          this.logger.warn(
            ` Fee estimation failed for cross-chain tx: ${e.message}`,
          );
        }
      }
    } else {
      this.logger.debug(
        'Skipping gas price estimation for non-EVM transaction',
        {
          sourceChain: sourceStep.chainId,
          ecosystem: sourceEcosystem,
        },
      );
    }

    // Fallback: Only use Rubic's gas limit if network estimation failed
    // This is a last resort as Rubic's gas limit may be inaccurate (e.g., 500000 placeholder)
    if (!tx.gasLimit) {
      const rubicGasLimit = swapQuote.gas || swapQuote.estimatedGas;
      if (rubicGasLimit) {
        // CRITICAL: Use Rubic's gas limit estimate even if it's high
        // Rejecting high gas limits causes "out of gas" failures (see transaction 0x120e9047...)
        // Better to use Rubic's estimate (even if high) than hardcoded fallback that's too low
        const MAX_REASONABLE_GAS_LIMIT = 600000;
        const MAX_ABSOLUTE_GAS_LIMIT = 5000000; // Absolute maximum to prevent obviously wrong values
        const rubicGasLimitNum = parseInt(rubicGasLimit);

        if (rubicGasLimitNum > MAX_ABSOLUTE_GAS_LIMIT) {
          // Only reject if it's absurdly high (likely a bug/placeholder)
          tx.gasLimit = '600000';
          this.logger.warn(
            'Rubic gas limit exceeds absolute maximum, using conservative fallback',
            {
              rubicGasLimit,
              maxAbsoluteGasLimit: MAX_ABSOLUTE_GAS_LIMIT,
              fallbackGasLimit: tx.gasLimit,
              note: 'Rubic gas limit is absurdly high (likely bug), using conservative estimate',
            },
          );
        } else if (rubicGasLimitNum > MAX_REASONABLE_GAS_LIMIT) {
          // Use Rubic's estimate even if it exceeds "reasonable" limit
          // Better to have enough gas than fail with "out of gas"
          tx.gasLimit = rubicGasLimit;
          this.logger.warn(
            'Using Rubic gas limit (exceeds reasonable limit, but better than fallback)',
            {
              rubicGasLimit,
              maxReasonableGasLimit: MAX_REASONABLE_GAS_LIMIT,
              gasLimit: tx.gasLimit,
              note: 'Rubic gas limit is high but will be used to prevent transaction failure. Network estimation failed.',
            },
          );
        } else {
          tx.gasLimit = rubicGasLimit;
          this.logger.warn(
            'Using Rubic gas limit as fallback (network estimation failed)',
            {
              gasLimit: tx.gasLimit,
              source: 'rubic-quote',
              note: 'Network estimation failed, using Rubic-provided gas limit',
            },
          );
        }
      } else {
        // Last resort: conservative default for bridge transactions
        // Use 600000 as default to prevent out-of-gas on bridges
        tx.gasLimit = '600000';
        this.logger.warn(
          'Using conservative default gas limit (all estimation methods failed)',
          {
            gasLimit: tx.gasLimit,
            source: 'conservative-default',
            note: 'Network estimation and Rubic gas limit both unavailable',
          },
        );
      }
    }

    // Validate gas limit is reasonable
    const gasLimitNum = parseInt(tx.gasLimit);
    if (gasLimitNum > 5_000_000) {
      this.logger.warn(' Unusually high gas limit for bridge transaction', {
        gasLimit: tx.gasLimit,
      });
    }

    // Log transaction details, including amount adjustment if present
    const logData: any = {
      to: tx.to,
      value: tx.value,
      dataLength: tx.data.length,
      gasLimit: tx.gasLimit,
      hasEIP1559: !!(tx.maxFeePerGas && tx.maxPriorityFeePerGas),
    };

    if (context.request.amountAdjustment) {
      logData.amountAdjustment = {
        originalAmount: context.request.amountAdjustment.originalAmount,
        adjustedAmount: context.request.amountAdjustment.adjustedAmount,
        gasCost: context.request.amountAdjustment.gasCost,
      };
      this.logger.log(
        'Cross-chain transaction built with amount adjustment',
        logData,
      );
    } else {
      this.logger.debug('Cross-chain transaction built successfully', logData);
    }

    return tx as {
      to: string;
      data: string;
      value: string;
      gasLimit?: string;
      gasPrice?: string;
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
    };
  }

  /**
   * Send cross-chain transaction to source chain
   * Handles both EVM and Solana transactions
   */
  protected async sendTransaction(
    txData: {
      to: string;
      data: string;
      value: string;
      gasLimit?: string;
      gasPrice?: string;
      functionSelector?: string;
      feeLimit?: string;
    },
    context: ExecutionContext,
  ): Promise<string> {
    const route = context.request.route;
    const sourceChainId = normalizeChainId(route.steps[0].chainId); // Can be number or string (e.g., 'solana-mainnet')
    const privateKey = context.request.privateKey;
    const swapQuote = route.providerRef as any;

    // Detect ecosystem from route/quote metadata
    const detectedEcosystem = this.detectEcosystem(sourceChainId);
    const isSolanaTransaction =
      swapQuote.isSolanaTransaction === true ||
      detectedEcosystem === 'solana' ||
      swapQuote?.depositInfo?.transferEcosystem === 'solana';
    const isTronTransaction =
      detectedEcosystem === 'tron' ||
      swapQuote?.depositInfo?.transferEcosystem === 'tron';
    const isBitcoinTransaction =
      detectedEcosystem === 'bitcoin' ||
      swapQuote?.depositInfo?.transferEcosystem === 'bitcoin';

    // Store ecosystem for waitForConfirmation to use
    this.currentEcosystem = isSolanaTransaction
      ? 'solana'
      : isTronTransaction
        ? 'tron'
        : isBitcoinTransaction
          ? 'bitcoin'
          : 'evm';

    // Store execution context for accessing route/providerRef in waitForConfirmation
    this.currentExecutionContext = context;

    this.logger.log('Sending cross-chain transaction to source chain', {
      aggregator: swapQuote.aggregator,
      sourceChain: sourceChainId,
      destChain: route.steps[route.steps.length - 1].chainId,
      userWallet: context.request.userWallet,
      isSolana: isSolanaTransaction,
      isTron: isTronTransaction,
      isBitcoin: isBitcoinTransaction,
      blockchain: swapQuote.sourceBlockchain,
    });

    try {
      // Implement retry logic with exponential backoff AND intelligent insufficient balance recovery
      // Bridge transactions can be more sensitive to network conditions
      let txHash: string;

      try {
        txHash = await this.retryWithBackoff(
          async () => {
            // Handle Solana transactions differently
            if (isSolanaTransaction) {
              // Solana has two execution paths:
              // 1. Base64 VersionedTransaction (direct swaps via aggregators like Jupiter)
              // 2. Token/SOL deposit transfer (CEX bridges like Exolix, ChangeNow)
              // Reference: https://docs.rubic.finance/rubic-api/rubic-api/integration-example/swaps-from-solana

              // Extract sell token address from route (for SPL token transfers)
              const sellToken =
                context.request.route.steps?.[0]?.details?.fromToken ||
                swapQuote.sellToken;

              // Build gasLimit JSON container with Solana-specific parameters
              // This allows wallet provider to:
              // 1. Apply swapFullBalance logic for SOL/SPL token transfers
              // 2. Augment compute budget if needed (for base64 transactions)
              // 3. Use dynamic fee calculation
              // 4. Handle SPL token transfers (when tokenAddress is provided)
              const gasLimitContainer = {
                swapFullBalance: context.request.swapFullBalance || false,
                computeUnits:
                  swapQuote.computeUnits || swapQuote.computeUnitLimit,
                priorityFeeMicroLamports:
                  swapQuote.priorityFee || swapQuote.priorityFeeMicroLamports,
                tokenAddress: sellToken, // For SPL token transfers to deposit address
              };

              const isDepositTrade = !!(swapQuote.depositInfo || txData.to);

              this.logger.debug(
                'Executing Solana transaction via WalletService',
                {
                  isDepositTrade,
                  hasTo: !!txData.to,
                  hasData: !!txData.data,
                  dataLength: txData.data?.length || 0,
                  sourceBlockchain: swapQuote.sourceBlockchain,
                  swapFullBalance: gasLimitContainer.swapFullBalance,
                  tokenAddress: gasLimitContainer.tokenAddress,
                  computeUnits: gasLimitContainer.computeUnits,
                  priorityFeeMicroLamports:
                    gasLimitContainer.priorityFeeMicroLamports,
                },
              );

              return await this.walletService.executeSwap(
                sourceChainId,
                privateKey,
                txData.to || '', // Deposit address for CEX trades, empty for base64 transactions
                txData.data, // Base64-encoded VersionedTransaction OR empty for deposit trades
                txData.value || '0', // Amount for deposit trades, '0' for base64 transactions
                JSON.stringify(gasLimitContainer), // Pass compute settings, swapFullBalance, and tokenAddress via gasLimit JSON
                'solana', // Ecosystem type - WalletService will handle Solana-specific logic
              );
            } else if (isTronTransaction) {
              this.logger.debug(
                'Executing Tron transaction via WalletService',
                {
                  to: txData.to,
                  value: txData.value,
                  sourceBlockchain: swapQuote.sourceBlockchain,
                  hasFunctionSelector: !!txData.functionSelector,
                  hasGasLimit: !!txData.gasLimit,
                },
              );

              // Merge all metadata: txData.gasLimit (may contain trc20Transfer info) + functionSelector + feeLimit
              // This ensures TRC20 transfer metadata is preserved and passed to wallet provider
              let tronMetadata: string | undefined;

              // If txData.gasLimit exists, it may already be a JSON string (e.g., for TRC20 transfers)
              // Parse it if it's a string, or use it directly if it's already an object
              if (txData.gasLimit) {
                tronMetadata = txData.gasLimit; // Already JSON.stringified in buildTransactionData
              } else if (txData.functionSelector || txData.feeLimit) {
                // Legacy path: only functionSelector and feeLimit provided (direct swaps)
                tronMetadata = JSON.stringify({
                  functionSelector: txData.functionSelector,
                  feeLimit: txData.feeLimit,
                });
              }

              return await this.walletService.executeSwap(
                sourceChainId,
                privateKey,
                txData.to,
                txData.data || '',
                txData.value,
                tronMetadata,
                'tron',
              );
            } else if (isBitcoinTransaction) {
              this.logger.debug(
                'Executing Bitcoin transaction via WalletService',
                {
                  to: txData.to,
                  value: txData.value,
                  sourceBlockchain: swapQuote.sourceBlockchain,
                },
              );

              return await this.walletService.executeSwap(
                sourceChainId,
                privateKey,
                txData.to,
                '',
                txData.value,
                undefined,
                'bitcoin',
              );
            } else {
              // EVM transaction - standard flow
              // Pass gas prices from quote to ensure consistency with fee calculation
              const gasPrices =
                swapQuote.maxFeePerGas || swapQuote.gasPrice
                  ? {
                      maxFeePerGas: swapQuote.maxFeePerGas,
                      maxPriorityFeePerGas: swapQuote.maxPriorityFeePerGas,
                      gasPrice: swapQuote.gasPrice,
                    }
                  : undefined;

              return await this.walletService.executeSwap(
                sourceChainId,
                privateKey,
                txData.to,
                txData.data,
                txData.value,
                txData.gasLimit,
                'evm', // Most bridges use EVM chains
                gasPrices, // Pass gas prices from estimation phase
              );
            }
          },
          3,
          2000,
        ); // 3 retries, 2s base delay
      } catch (firstAttemptError) {
        // Check if this is an insufficient balance error
        if (this.isInsufficientBalanceError(firstAttemptError as Error)) {
          this.logger.warn(
            '⚠️ Insufficient balance detected - attempting re-adjustment',
            {
              originalError: (firstAttemptError as Error).message,
              note: 'Gas price likely increased since estimation',
            },
          );

          // Extract overshot amount from error message if available
          const errorMsg = (firstAttemptError as Error).message;
          const overshotMatch = errorMsg.match(/overshot[:\s]+(\d+)/i);
          const overshotAmount = overshotMatch ? BigInt(overshotMatch[1]) : 0n;

          this.logger.debug('Overshot amount detected', {
            overshotAmount: overshotAmount.toString(),
            source: 'error message parsing',
          });

          // Calculate new reduced amount
          const currentValue = BigInt(txData.value || '0');
          const reductionBuffer =
            overshotAmount > 0n
              ? (overshotAmount * 120n) / 100n // 120% of overshot to ensure success
              : currentValue / 100n; // Fallback: reduce by 1%

          const newValue = currentValue - reductionBuffer;

          if (newValue <= 0n) {
            this.logger.error(
              '❌ Cannot reduce amount further - insufficient funds',
              {
                currentValue: currentValue.toString(),
                reductionBuffer: reductionBuffer.toString(),
              },
            );
            throw firstAttemptError;
          }

          this.logger.log('🔄 Re-executing with reduced amount', {
            originalValue: currentValue.toString(),
            reductionBuffer: reductionBuffer.toString(),
            newValue: newValue.toString(),
            percentReduction:
              ((reductionBuffer * 100n) / currentValue).toString() + '%',
          });

          // Update transaction value and retry ONCE with reduced amount
          const adjustedTxData = {
            ...txData,
            value: newValue.toString(),
          };

          // Single retry with adjusted amount (no exponential backoff needed)
          try {
            txHash = await (async () => {
              if (isSolanaTransaction) {
                const sellToken =
                  context.request.route.steps?.[0]?.details?.fromToken ||
                  swapQuote.sellToken;
                const gasLimitContainer = {
                  swapFullBalance: context.request.swapFullBalance || false,
                  computeUnits:
                    swapQuote.computeUnits || swapQuote.computeUnitLimit,
                  priorityFeeMicroLamports:
                    swapQuote.priorityFee || swapQuote.priorityFeeMicroLamports,
                  tokenAddress: sellToken,
                };

                return await this.walletService.executeSwap(
                  sourceChainId,
                  privateKey,
                  adjustedTxData.to || '',
                  adjustedTxData.data,
                  adjustedTxData.value || '0',
                  JSON.stringify(gasLimitContainer),
                  'solana',
                );
              } else if (isTronTransaction) {
                return await this.walletService.executeSwap(
                  sourceChainId,
                  privateKey,
                  adjustedTxData.to,
                  adjustedTxData.data || '',
                  adjustedTxData.value,
                  undefined,
                  'tron',
                );
              } else if (isBitcoinTransaction) {
                return await this.walletService.executeSwap(
                  sourceChainId,
                  privateKey,
                  adjustedTxData.to,
                  '',
                  adjustedTxData.value,
                  undefined,
                  'bitcoin',
                );
              } else {
                // EVM transaction with adjusted value
                // Pass gas prices from quote to ensure consistency
                const gasPrices =
                  swapQuote.maxFeePerGas || swapQuote.gasPrice
                    ? {
                        maxFeePerGas: swapQuote.maxFeePerGas,
                        maxPriorityFeePerGas: swapQuote.maxPriorityFeePerGas,
                        gasPrice: swapQuote.gasPrice,
                      }
                    : undefined;

                return await this.walletService.executeSwap(
                  sourceChainId,
                  privateKey,
                  adjustedTxData.to,
                  adjustedTxData.data,
                  adjustedTxData.value,
                  adjustedTxData.gasLimit,
                  'evm',
                  gasPrices, // Pass gas prices from estimation phase
                );
              }
            })();

            this.logger.log(
              '✅ Transaction successful after amount re-adjustment',
              {
                adjustedValue: newValue.toString(),
                transactionHash: txHash,
              },
            );
          } catch (secondAttemptError) {
            this.logger.error('❌ Re-adjusted transaction also failed', {
              adjustedValue: newValue.toString(),
              error: (secondAttemptError as Error).message,
            });
            throw secondAttemptError;
          }
        } else {
          // Not an insufficient balance error - re-throw original error
          throw firstAttemptError;
        }
      }

      this.logger.log(` Cross-chain transaction sent on source chain`, {
        txHash,
        aggregator: swapQuote.aggregator,
        sourceChain: sourceChainId,
        explorerUrl: this.getExplorerUrl(sourceChainId, txHash), // Source chain explorer
        bridgeStatusUrl: this.getProviderTrackingUrl(route, txHash), // Provider tracking URL
        isSolana: isSolanaTransaction,
      });

      // Store transaction hash for bridge monitoring
      // The receipt will include this for tracking
      this.logger.debug('Transaction hash stored for cross-chain tracking', {
        txHash,
        sourceChain: sourceChainId,
        destChain: route.steps[route.steps.length - 1].chainId,
        isSolana: isSolanaTransaction,
      });

      return txHash;
    } catch (error) {
      this.logger.error(` Cross-chain transaction failed: ${error.message}`, {
        aggregator: swapQuote.aggregator,
        sourceChain: sourceChainId,
        destChain: route.steps[route.steps.length - 1].chainId,
        isSolana: isSolanaTransaction,
        isTron: isTronTransaction,
        isBitcoin: isBitcoinTransaction,
        error: error.message,
        errorStack: error.stack,
      });

      // Add cross-chain specific error handling
      const errorMessage = (error.message || '').toLowerCase();

      if (isSolanaTransaction) {
        // Solana-specific error handling
        if (
          errorMessage.includes('insufficient') ||
          errorMessage.includes('balance')
        ) {
          throw new Error(
            `Insufficient SOL balance for transaction. ` +
              `Please ensure you have enough SOL for rent + transaction fees.`,
          );
        } else if (
          errorMessage.includes('blockhash') ||
          errorMessage.includes('expired')
        ) {
          throw new Error(
            `Solana transaction expired. Recent blockhash is no longer valid. Please try again.`,
          );
        } else if (
          errorMessage.includes('signature') ||
          errorMessage.includes('invalid')
        ) {
          throw new Error(
            `Solana transaction signature failed. Please check your wallet and try again.`,
          );
        } else if (
          errorMessage.includes('base64') ||
          errorMessage.includes('decode')
        ) {
          throw new Error(
            `Invalid Solana transaction data. The base64-encoded transaction is malformed.`,
          );
        }
      } else {
        // EVM-specific error handling
        if (
          errorMessage.includes('insufficient funds') ||
          errorMessage.includes('insufficient balance')
        ) {
          throw new Error(
            `Insufficient funds on source chain for transaction. ` +
              `Please ensure you have enough tokens + gas fees.`,
          );
        } else if (
          errorMessage.includes('gas required exceeds allowance') ||
          errorMessage.includes('out of gas')
        ) {
          throw new Error(
            `Transaction gas limit too low. Bridge transactions require more gas than typical swaps.`,
          );
        } else if (
          errorMessage.includes('execution reverted') ||
          errorMessage.includes('revert')
        ) {
          throw new Error(
            `Bridge contract execution failed. This may be due to:\n` +
              `- Insufficient liquidity on destination chain\n` +
              `- Bridge limits exceeded\n` +
              `- Slippage tolerance too low\n` +
              `Please try a different route or reduce amount.`,
          );
        } else if (errorMessage.includes('nonce')) {
          throw new Error(`Transaction nonce error. Please try again.`);
        } else if (
          errorMessage.includes('replacement transaction underpriced')
        ) {
          throw new Error(
            `Transaction pending. Please wait for previous transaction to complete or increase gas price.`,
          );
        }
      }

      // Network errors (common to both)
      if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('network')
      ) {
        throw new Error(
          `Network error on source chain. Please check your connection and try again.`,
        );
      }

      // Generic error with original message
      throw new Error(
        `Cross-chain execution failed on source chain (${isSolanaTransaction ? 'Solana' : isTronTransaction ? 'Tron' : isBitcoinTransaction ? 'Bitcoin' : 'EVM'}): ${error.message}`,
      );
    }
  }

  /**
   * Wait for cross-chain transaction completion
   * Monitors both source and destination chains
   * Handles both EVM and Solana transactions
   */
  async waitForConfirmation(
    transactionHash: string,
    chainId: number | string,
    requiredConfirmations: number = 3, // Reduced confirmations for faster execution
  ): Promise<any> {
    // Use the ecosystem detected in sendTransaction
    const ecosystem = this.currentEcosystem;

    this.logger.log(`Waiting for cross-chain transaction confirmation`, {
      sourceTxHash: transactionHash,
      sourceChain: normalizeChainId(chainId),
      requiredConfirmations,
      ecosystem,
    });

    try {
      // Step 1: Wait for source chain confirmation
      // Use more confirmations to ensure finality before bridge processes
      this.logger.log(
        `Step 1: Waiting for source chain confirmation (${requiredConfirmations} ${ecosystem === 'solana' ? 'finalized' : 'blocks'})...`,
      );

      const sourceReceipt =
        await this.walletService.waitForTransactionConfirmation(
          normalizeChainId(chainId),
          transactionHash,
          requiredConfirmations,
          ecosystem,
        );

      this.logger.log(` Source chain transaction confirmed`, {
        txHash: transactionHash,
        blockchain: ecosystem.toUpperCase(),
        blockNumber: sourceReceipt.blockNumber,
        gasUsed: sourceReceipt.gasUsed?.toString(),
        status: sourceReceipt.status ? 'success' : 'failed',
      });

      // Verify transaction succeeded
      if (!sourceReceipt.status || sourceReceipt.status === 0) {
        throw new Error(
          `Source chain transaction failed - transaction ${ecosystem === 'solana' ? 'rejected' : 'reverted'}`,
        );
      }

      // Step 2: Monitor bridge status (best-effort)
      this.logger.log(`Step 2: Bridge transfer initiated - monitoring...`);

      // Use stored execution context to access route/providerRef with Rubic ID
      if (!this.currentExecutionContext) {
        throw new Error(
          'Execution context not available for bridge status polling',
        );
      }

      const bridgeInfo = await this.pollBridgeStatus(
        transactionHash,
        normalizeChainId(chainId),
        sourceReceipt,
        this.currentExecutionContext,
      );

      // Construct destination explorer URL if destination chain and tx hash are available
      let destExplorerUrl: string | undefined;
      if (bridgeInfo.destTxHash && bridgeInfo.destChainId) {
        destExplorerUrl = this.getExplorerUrl(
          bridgeInfo.destChainId,
          bridgeInfo.destTxHash,
        );

        this.logger.log(' Destination transaction found', {
          destTxHash: bridgeInfo.destTxHash,
          destChain: bridgeInfo.destChainName || bridgeInfo.destChainId,
          destExplorerUrl,
        });
      }

      // Return combined status
      return {
        ...sourceReceipt,
        sourceChainTxHash: transactionHash,
        sourceChainId: normalizeChainId(chainId),
        sourceEcosystem: ecosystem,
        bridgeStatus: bridgeInfo.status,
        destChainTxHash: bridgeInfo.destTxHash,
        destChainId: bridgeInfo.destChainId,
        destChainName: bridgeInfo.destChainName,
        destExplorerUrl, // Add destination explorer URL
        estimatedCompletionTime:
          bridgeInfo.etaMs ?? this.estimateBridgeCompletionTime(),
        bridgeStatusUrl:
          bridgeInfo.statusUrl ??
          this.getBridgeStatusUrl(
            transactionHash,
            normalizeChainId(chainId),
            this.currentExecutionContext?.request.route.providerRef?.aggregator,
          ),
        note: 'Cross-chain transfer initiated. Monitoring bridge status.',
      };
    } catch (error) {
      this.logger.error(` Cross-chain confirmation failed: ${error.message}`, {
        txHash: transactionHash,
        sourceChainId: normalizeChainId(chainId),
        error: error.message,
      });

      if (error.message.includes('timeout')) {
        throw new Error(
          `Source chain confirmation timeout. Transaction may still be processing. ` +
            `Check status at: ${this.getExplorerUrl(normalizeChainId(chainId), transactionHash)}`,
        );
      }

      throw error;
    }
  }

  /**
   * Poll Rubic bridge status to discover destination tx hash and final status.
   * Best-effort: runs a few attempts with backoff and returns last known status.
   */
  /**
   * Poll bridge status to discover destination tx hash and final status.
   * Best-effort: runs a few attempts with backoff and returns last known status.
   * Only polls for Rubic aggregator - other providers get pending status with explorer links.
   *
   * @param sourceTxHash - Source chain transaction hash
   * @param sourceChainId - Source chain ID
   * @param sourceReceipt - Source chain transaction receipt
   * @param context - Execution context containing route information
   * @returns Bridge status with destination transaction hash and chain info
   */
  private async pollBridgeStatus(
    sourceTxHash: string,
    sourceChainId: number | string,
    sourceReceipt: any,
    context: ExecutionContext,
  ): Promise<{
    status:
      | 'initiated'
      | 'pending'
      | 'in_progress'
      | 'completed'
      | 'failed'
      | 'reverted';
    destTxHash?: string;
    destChainId?: number | string;
    destChainName?: string;
    etaMs?: number;
    statusUrl?: string;
  }> {
    try {
      // Get route information from context (contains the latest providerRef with Rubic ID)
      const route = context.request.route;
      const swapQuote = route.providerRef;
      const aggregator = swapQuote?.aggregator?.toLowerCase();

      this.logger.debug('Checking bridge status', {
        aggregator,
        sourceTxHash,
        sourceChainId,
      });

      // Only poll Rubic API for status - other providers don't have status APIs
      if (aggregator === 'rubic') {
        return await this.pollRubicBridgeStatus(sourceTxHash, swapQuote);
      } else {
        // For non-Rubic providers, construct provider-specific explorer URLs
        // Don't poll - just return pending status with appropriate URLs
        this.logger.debug(
          `Non-Rubic provider (${aggregator || 'unknown'}) - skipping status polling`,
        );

        return {
          status: 'pending',
          destTxHash: undefined,
          destChainId: undefined,
          etaMs: 30 * 60 * 1000, // 30 minutes default
          // Return provider-specific status URL based on aggregator
          statusUrl: this.getProviderStatusUrl(aggregator, sourceTxHash),
        };
      }
    } catch (error) {
      this.logger.warn(`Bridge status check failed: ${error.message}`);

      // Return pending status on error - don't break the flow
      return {
        status: 'pending',
        etaMs: 30 * 60 * 1000,
        statusUrl: this.getProviderStatusUrl('unknown', sourceTxHash),
      };
    }
  }

  /**
   * Poll Rubic bridge status API with exponential backoff
   * Makes up to 3 attempts with 5s, 10s, 20s delays between attempts
   *
   * @param sourceTxHash - Source chain transaction hash
   * @param swapQuote - Swap quote containing provider reference data
   * @returns Bridge status with destination transaction hash and chain info
   */
  private async pollRubicBridgeStatus(
    sourceTxHash: string,
    swapQuote: any,
  ): Promise<{
    status:
      | 'initiated'
      | 'pending'
      | 'in_progress'
      | 'completed'
      | 'failed'
      | 'reverted';
    destTxHash?: string;
    destChainId?: number | string;
    destChainName?: string;
    etaMs?: number;
    statusUrl?: string;
  }> {
    this.logger.log(' Polling Rubic bridge status...');

    const attempts = 3;
    const baseDelayMs = 5000;
    let lastStatus: any;

    for (let i = 0; i < attempts; i++) {
      try {
        const status = await this.rubicService.getBridgeStatus(
          sourceTxHash,
          swapQuote,
        );
        lastStatus = status;

        this.logger.debug('Rubic bridge status poll', {
          attempt: i + 1,
          status: status.status,
          destTxHash: status.destTxHash,
          destChainName: status.destChainName,
          destChainId: status.destChainId,
        });

        // If completed or failed, stop polling
        if (status.status === 'completed' || status.status === 'failed') {
          this.logger.log(` Rubic bridge status: ${status.status}`, {
            destTxHash: status.destTxHash,
            destChain: status.destChainName || status.destChainId,
          });
          break;
        }
      } catch (e) {
        this.logger.warn(
          `Bridge status poll failed (attempt ${i + 1}/${attempts}): ${e.message}`,
        );
      }

      // Exponential backoff: 5s, 10s, 20s
      const delay = baseDelayMs * Math.pow(2, i);
      await new Promise((res) => setTimeout(res, delay));
    }

    // Return last known status or pending with default values
    return (
      lastStatus ?? {
        status: 'pending',
        etaMs: 30 * 60 * 1000, // 30 minutes default
        statusUrl: `https://api-v2.rubic.exchange/api/info/status?srcTxHash=${sourceTxHash}`,
      }
    );
  }

  /**
   * Get provider-specific status URL for tracking cross-chain transfers
   * @param aggregator - Aggregator name (lifi, socket, rubic, etc.)
   * @param txHash - Source transaction hash
   * @returns Status tracking URL
   */
  private getProviderStatusUrl(
    aggregator: string | undefined,
    txHash: string,
  ): string {
    const providerStatusUrls: Record<string, (hash: string) => string> = {
      lifi: (hash) => `https://scan.li.fi/tx/${hash}`,
      socket: (hash) => `https://socketscan.io/tx/${hash}`,
      rubic: (hash) =>
        `https://api-v2.rubic.exchange/api/info/status?srcTxHash=${hash}`,
      stargate: (hash) => `https://stargate.finance/tx/${hash}`,
      across: (hash) => `https://across.to/transactions?search=${hash}`,
      symbiosis: (hash) => `https://app.symbiosis.finance/explorer/tx/${hash}`,
      hop: (hash) => `https://explorer.hop.exchange/tx/${hash}`,
      connext: (hash) => `https://connextscan.io/tx/${hash}`,
      squid: (hash) => `https://axelarscan.io/gmp/${hash}`,
      squidrouter: (hash) => `https://axelarscan.io/gmp/${hash}`,
      rango: (hash) => `https://rango.exchange/tx/${hash}`,
      relay: (hash) => `https://relay.link/tx/${hash}`,
    };

    const statusUrlFn = providerStatusUrls[aggregator?.toLowerCase() || ''];
    return statusUrlFn
      ? statusUrlFn(txHash)
      : `https://socketscan.io/tx/${txHash}`;
  }

  /**
   * Get required confirmations for cross-chain based on source chain
   * Different chains have different finality requirements
   */
  protected getRequiredConfirmations(chainId?: number | string): number {
    // Tron requires more confirmations for solid finality (~20 blocks)
    // Tron block time is ~3 seconds, so 20 blocks = ~60 seconds
    if (
      chainId &&
      (chainId === 195 || chainId === 'tron-mainnet' || chainId === 'tron')
    ) {
      return 20; // Tron needs 20 confirmations
    }

    // EVM chains: 3 confirmations is sufficient for most chains
    // Ethereum: 12-15 seconds per block, 3 blocks = ~36-45 seconds
    // BSC: 3 seconds per block, 3 blocks = ~9 seconds
    // Polygon: 2 seconds per block, 3 blocks = ~6 seconds
    return 3;
  }

  /**
   * Post-execution processing for cross-chain
   */
  protected async postExecute(
    context: ExecutionContext,
    txHash: string,
    receipt: any,
  ): Promise<void> {
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;
    const sellTokenDecimals = this.resolveSellTokenDecimals(route, swapQuote);

    // Calculate execution time from quote timestamp
    const executionTime = swapQuote.timestamp
      ? Date.now() - swapQuote.timestamp
      : undefined;

    // Calculate price metrics
    const sellAmountNum = Number(swapQuote.sellAmount);
    const buyAmountNum = Number(swapQuote.buyAmount);
    const executionPrice =
      sellAmountNum > 0 ? (buyAmountNum / sellAmountNum).toFixed(6) : 'N/A';

    // Calculate and log remaining balance after transaction execution
    // This helps analyze how well we're utilizing the wallet balance for swapFullBalance=true
    if (context.request.amountAdjustment && route.steps?.[0]?.chainId) {
      try {
        const sourceChainId = route.steps[0].chainId;
        const normalizedChainId = normalizeChainId(sourceChainId);
        const isEVMChain = typeof normalizedChainId === 'number';

        if (
          isEVMChain &&
          swapQuote.sellToken === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        ) {
          // Fetch current balance after transaction
          const currentBalance = await this.getNativeTokenBalance(
            normalizedChainId,
            context.request.userWallet,
          );
          const currentBalanceBigInt = BigInt(currentBalance);

          // Calculate actual gas cost from receipt
          let actualGasCost = '0';
          if (receipt.gasUsed) {
            const gasUsed = BigInt(receipt.gasUsed.toString());

            // Try to get effectiveGasPrice from receipt (EIP-1559)
            if (receipt.effectiveGasPrice) {
              const effectiveGasPrice = BigInt(
                receipt.effectiveGasPrice.toString(),
              );
              actualGasCost = (gasUsed * effectiveGasPrice).toString();
            } else if (receipt.gasPrice) {
              // Legacy gas price
              const gasPrice = BigInt(receipt.gasPrice.toString());
              actualGasCost = (gasUsed * gasPrice).toString();
            } else {
              // Fallback: estimate from maxFeePerGas if available
              // For EIP-1559: effectiveGasPrice = min(maxFeePerGas, baseFee + priorityFee)
              // We'll use a conservative estimate: gasUsed * maxFeePerGas
              const adjustment = context.request.amountAdjustment;
              if (adjustment.gasCost) {
                // Use estimated gas cost as fallback
                const estimatedGasCostBigInt = BigInt(adjustment.gasCost);
                // Scale by actual gas used / estimated gas limit
                const estimatedGasLimit = BigInt(adjustment.gasLimit || '0');
                if (estimatedGasLimit > 0n) {
                  actualGasCost = (
                    (estimatedGasCostBigInt * gasUsed) /
                    estimatedGasLimit
                  ).toString();
                } else {
                  actualGasCost = estimatedGasCostBigInt.toString();
                }
              }
            }
          }

          const actualGasCostBigInt = BigInt(actualGasCost);
          const transactionValueBigInt = this.convertAmountStringToBaseUnits(
            swapQuote.value || swapQuote.sellAmount || '0',
            sellTokenDecimals,
          );
          const initialBalanceBigInt =
            currentBalanceBigInt + transactionValueBigInt + actualGasCostBigInt;

          // Calculate remaining balance
          const remainingBalance = currentBalanceBigInt;
          const remainingBalancePercent =
            initialBalanceBigInt > 0n
              ? (
                  (remainingBalance * BigInt(10000)) /
                  initialBalanceBigInt
                ).toString()
              : '0';

          // Calculate difference from expected
          const adjustment = context.request.amountAdjustment;
          const expectedRemainingBalance =
            initialBalanceBigInt -
            BigInt(adjustment.adjustedAmount) -
            BigInt(adjustment.gasCost);
          const differenceFromExpected =
            remainingBalance > expectedRemainingBalance
              ? remainingBalance - expectedRemainingBalance
              : expectedRemainingBalance - remainingBalance;

          this.logger.log(
            'Remaining balance analysis after transaction execution',
            {
              initialBalance: initialBalanceBigInt.toString(),
              transactionValue: transactionValueBigInt.toString(),
              estimatedGasCost: adjustment.gasCost,
              actualGasUsed: receipt.gasUsed?.toString(),
              actualGasCost: actualGasCost,
              actualRemainingBalance: remainingBalance.toString(),
              expectedRemainingBalance: expectedRemainingBalance.toString(),
              differenceFromExpected: differenceFromExpected.toString(),
              remainingBalancePercent:
                remainingBalancePercent + ' basis points',
              remainingBalancePercentHuman:
                (Number(remainingBalancePercent) / 100).toFixed(4) + '%',
              swapFullBalance: context.request.swapFullBalance || false,
              note:
                'Actual remaining balance = current balance. Expected = initialBalance - transactionValue - estimatedGasCost. ' +
                'Difference indicates gas estimation accuracy and Rubic rounding impact.',
            },
          );
        }
      } catch (error) {
        // Log error but don't fail the execution
        this.logger.warn(
          'Failed to calculate remaining balance after transaction',
          {
            error: error.message,
            txHash,
          },
        );
      }
    }

    // Log comprehensive execution metrics
    this.logger.log(' Cross-chain swap execution completed on source chain', {
      // Transaction identifiers
      sourceTxHash: txHash,
      blockNumber: receipt.blockNumber,

      // Chain information
      sourceChain: route.steps[0].chainId,
      destChain: route.steps[route.steps.length - 1].chainId,

      // Aggregator info
      aggregator: swapQuote.aggregator,

      // Trade details
      sellToken: swapQuote.sellToken,
      buyToken: swapQuote.buyToken,
      sellAmount: swapQuote.sellAmount,
      buyAmount: swapQuote.buyAmount,
      executionPrice,

      // Performance metrics
      priceImpact: swapQuote.priceImpact
        ? `${swapQuote.priceImpact}%`
        : undefined,
      gasUsed: receipt.gasUsed?.toString(),
      executionTimeMs: executionTime,
      executionTimeSec: executionTime
        ? `${(executionTime / 1000).toFixed(2)}s`
        : undefined,

      // Bridge information
      bridgeStatus: receipt.bridgeStatus || 'initiated',
      destChainTxHash: receipt.destChainTxHash || 'pending',
      destChainName: receipt.destChainName,
      estimatedBridgeTime: receipt.estimatedCompletionTime
        ? `${Math.round(receipt.estimatedCompletionTime / 60000)} minutes`
        : '5-30 minutes',

      // Explorer links - ALL THREE URLs for complete tracking
      sourceExplorerUrl: this.getExplorerUrl(route.steps[0].chainId, txHash), // Source chain explorer (Etherscan, BSCScan, etc.)
      bridgeStatusUrl:
        receipt.bridgeStatusUrl ||
        this.getBridgeStatusUrl(
          txHash,
          route.steps[0].chainId,
          swapQuote.aggregator,
        ), // Provider tracking (LiFi, Socket, Symbiosis API, etc.)
      destExplorerUrl: receipt.destExplorerUrl, // Destination chain explorer (when available)
    });

    // Log bridge-specific information
    const bridgeStatusLog: any = {
      status: 'Source chain confirmed - Bridge processing',
      note: 'Monitor bridge status URL for destination chain completion',
      bridgeStatusUrl:
        receipt.bridgeStatusUrl ||
        this.getBridgeStatusUrl(
          txHash,
          route.steps[0].chainId,
          swapQuote.aggregator,
        ),
      estimatedTime: '5-30 minutes depending on bridge protocol',
    };

    // Add destination info if available
    if (receipt.destChainTxHash) {
      bridgeStatusLog.destChainTxHash = receipt.destChainTxHash;
      bridgeStatusLog.destChain = receipt.destChainName || receipt.destChainId;
      bridgeStatusLog.destExplorerUrl = receipt.destExplorerUrl;
    }

    this.logger.log(' Bridge Transfer Status', bridgeStatusLog);

    // Validate source transaction success
    if (!receipt.status || receipt.status === 0) {
      this.logger.error(
        ' Source transaction failed - cross-chain transfer will not complete',
        {
          txHash,
          receipt,
        },
      );
    }
  }

  /**
   * Get explorer URLs for both source and destination chains
   */
  protected getExplorerUrl(chainId: number | string, txHash: string): string {
    const normalized = normalizeChainId(chainId);
    const normalizedStr = normalized.toString();

    // Handle Solana and Tron string-based identifiers first
    if (typeof normalized === 'string') {
      // Solana mainnet
      if (
        normalizedStr.includes('solana-mainnet') ||
        normalizedStr === 'solana' ||
        normalizedStr === 'mainnet-beta'
      ) {
        return `https://solscan.io/tx/${txHash}`;
      }

      // Solana devnet
      if (
        normalizedStr.includes('solana-devnet') ||
        normalizedStr === 'devnet'
      ) {
        return `https://explorer.solana.com/tx/${txHash}?cluster=devnet`;
      }

      // Solana testnet
      if (
        normalizedStr.includes('solana-testnet') ||
        normalizedStr === 'testnet'
      ) {
        return `https://explorer.solana.com/tx/${txHash}?cluster=testnet`;
      }

      // Tron networks
      if (
        normalizedStr.includes('tron-mainnet') ||
        normalizedStr === 'tron' ||
        normalizedStr === 'trx'
      ) {
        return `https://tronscan.org/#/transaction/${txHash}`;
      }

      if (
        normalizedStr.includes('shasta') ||
        normalizedStr.includes('tron-testnet')
      ) {
        return `https://shasta.tronscan.org/#/transaction/${txHash}`;
      }

      if (normalizedStr.includes('nile')) {
        return `https://nile.tronscan.org/#/transaction/${txHash}`;
      }
    }

    // Handle Solana numeric chainId variants
    const chainIdNum =
      typeof normalized === 'string' ? parseInt(normalized) : normalized;
    if (
      chainIdNum === 1399811149 ||
      chainIdNum === 900 ||
      chainIdNum === 901 ||
      chainIdNum === 7565164 ||
      normalized === 'solana-mainnet'
    ) {
      // 1399811149 = Rubic's Solana mainnet ID
      // 900 = Our convention for Solana mainnet
      // 901 = Our convention for Solana devnet
      if (chainIdNum === 901) {
        return `https://explorer.solana.com/tx/${txHash}?cluster=devnet`;
      }
      return `https://solscan.io/tx/${txHash}`;
    }

    // Tron numeric IDs
    if (chainIdNum === 195) {
      return `https://tronscan.org/#/transaction/${txHash}`;
    }

    // EVM chain explorers
    const explorerMap: Record<number, string> = {
      1: 'https://etherscan.io',
      137: 'https://polygonscan.com',
      56: 'https://bscscan.com',
      42161: 'https://arbiscan.io',
      10: 'https://optimistic.etherscan.io',
      43114: 'https://snowtrace.io',
      8453: 'https://basescan.org',
      250: 'https://ftmscan.com',
      42220: 'https://celoscan.io',
      100: 'https://gnosisscan.io',
      324: 'https://explorer.zksync.io',
      1101: 'https://zkevm.polygonscan.com',
      59144: 'https://lineascan.build',
      // Add more chains as needed
    };

    const explorerBaseUrl = explorerMap[chainIdNum] || 'https://etherscan.io';
    return `${explorerBaseUrl}/tx/${txHash}`;
  }

  /**
   * Resolve sell token decimals from route metadata or provider reference
   */
  private resolveSellTokenDecimals(
    route: RouteQuote,
    swapQuote: SwapQuote,
  ): number | undefined {
    const firstStepDetails = route.steps?.[0]?.details;
    const detailDecimals =
      firstStepDetails?.fromToken?.decimals ??
      firstStepDetails?.fromTokenDecimals ??
      firstStepDetails?.token?.decimals;
    if (typeof detailDecimals === 'number') {
      return detailDecimals;
    }

    const providerRef: any = swapQuote;
    const providerDecimals =
      providerRef?.sellTokenDecimals ??
      providerRef?.sourceTokenDecimals ??
      providerRef?.tokens?.from?.decimals ??
      providerRef?.apiResponse?.tokens?.from?.decimals ??
      providerRef?.apiResponse?.tokens?.srcToken?.decimals ??
      providerRef?.apiResponse?.tokens?.src?.decimals;

    if (typeof providerDecimals === 'number') {
      return providerDecimals;
    }

    return undefined;
  }

  /**
   * Convert decimal amount strings to base units (wei, sun, etc.)
   */
  private convertAmountStringToBaseUnits(
    amount: string | undefined,
    decimals?: number,
  ): bigint {
    if (!amount || amount === '0') {
      return 0n;
    }

    if (amount.includes('.')) {
      const decimalsToUse = typeof decimals === 'number' ? decimals : 18;
      try {
        return parseUnits(amount, decimalsToUse);
      } catch (error) {
        const [integerPartRaw, fractionalRaw = ''] = amount.split('.');
        const integerPart = integerPartRaw === '' ? '0' : integerPartRaw;
        const paddedFraction = (
          fractionalRaw + '0'.repeat(decimalsToUse)
        ).slice(0, decimalsToUse);
        this.logger.warn(
          'Failed to parse decimal amount with parseUnits, using manual conversion',
          {
            amount,
            decimals: decimalsToUse,
            error: (error as Error).message,
          },
        );
        return (
          BigInt(integerPart) * BigInt(10) ** BigInt(decimalsToUse) +
          BigInt(paddedFraction || '0')
        );
      }
    }

    return BigInt(amount);
  }

  /**
   * Get bridge status tracking URL with chainId support
   * Returns provider-specific tracking URLs for cross-chain operations
   *
   * @param txHash - Source transaction hash
   * @param sourceChainId - Source blockchain ID
   * @param aggregator - Optional aggregator name for provider-specific URLs
   * @returns Status tracking URL
   */
  protected getBridgeStatusUrl(
    txHash: string,
    sourceChainId: number | string,
    aggregator?: string,
  ): string {
    const normalizedChainId = normalizeChainId(sourceChainId);
    const aggregatorLower = aggregator?.toLowerCase();

    // Provider-specific status URLs that require chainId
    switch (aggregatorLower) {
      case 'symbiosis':
        // Symbiosis API endpoint: /v2/tx/{chainId}/{transactionHash}
        // Uses Symbiosis-specific chain IDs (e.g., 195 for Tron, 728126428 for Tron in their system)
        return `https://api.symbiosis.finance/crosschain/v2/tx/${normalizedChainId}/${txHash}`;

      case 'rubic':
        // Rubic status API endpoint
        return `https://api-v2.rubic.exchange/api/info/status?srcTxHash=${txHash}`;

      case 'lifi':
        return `https://scan.li.fi/tx/${txHash}`;

      case 'socket':
        return `https://socketscan.io/tx/${txHash}`;

      case 'stargate':
        return `https://stargate.finance/tx/${txHash}`;

      case 'across':
        return `https://across.to/transactions?search=${txHash}`;

      case 'hop':
        return `https://explorer.hop.exchange/tx/${txHash}`;

      case 'connext':
        return `https://connextscan.io/tx/${txHash}`;

      case 'squid':
      case 'squidrouter':
        return `https://axelarscan.io/gmp/${txHash}`;

      case 'rango':
        return `https://rango.exchange/tx/${txHash}`;

      case 'relay':
        return `https://relay.link/tx/${txHash}`;

      default:
        // Generic fallback
        return `https://socketscan.io/tx/${txHash}`;
    }
  }

  /**
   * Estimate bridge completion time based on protocol
   * Returns time in milliseconds
   */
  protected estimateBridgeCompletionTime(): number {
    // Different bridges have different completion times:
    // - Fast bridges (Stargate, Hop): 5-15 minutes
    // - Standard bridges (Across, Connext): 15-30 minutes
    // - Slow bridges (Native bridges): 30-60 minutes

    // Return conservative estimate: 30 minutes
    return 30 * 60 * 1000; // 30 minutes in milliseconds
  }

  /**
   * Enrich the base execution result with cross-chain tracking fields
   */
  protected augmentExecutionResult(
    context: ExecutionContext,
    result: ExecutionResult,
    receipt: any,
  ): ExecutionResult {
    try {
      const route = context.request.route;
      const destChainId = route?.steps?.[route.steps.length - 1]?.chainId;
      const destTxHash = receipt?.destChainTxHash;

      const enriched: ExecutionResult = {
        ...result,
        bridgeStatus: receipt?.bridgeStatus || 'initiated',
        bridgeStatusUrl: receipt?.bridgeStatusUrl,
        destChainId,
        destTransactionHash: destTxHash,
        destExplorerUrl:
          destChainId && destTxHash
            ? this.getExplorerUrl(destChainId, destTxHash)
            : undefined,
      };

      return enriched;
    } catch (e) {
      // On any error, return base result unchanged
      return result;
    }
  }

  /**
   * Check if error is due to insufficient balance
   * Detects when gas price increased or balance calculation was incorrect
   */
  private isInsufficientBalanceError(error: Error): boolean {
    const errorMessage = (error.message || '').toLowerCase();

    // Common insufficient balance error patterns
    return (
      errorMessage.includes('insufficient funds') ||
      errorMessage.includes('insufficient balance') ||
      (errorMessage.includes('balance') && errorMessage.includes('exceed')) ||
      errorMessage.includes('overshot') ||
      errorMessage.includes('gas * price + value') ||
      errorMessage.includes('balance of the account')
    );
  }

  /**
   * Retry with exponential backoff
   * Now with intelligent error detection:
   * - Insufficient balance errors → Don't retry, let caller handle re-adjustment
   * - Network/RPC errors → Retry with exponential backoff
   */
  protected async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number,
    baseDelay: number,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // Check if this is an insufficient balance error
        if (this.isInsufficientBalanceError(lastError)) {
          this.logger.error(
            '❌ Insufficient balance detected - stopping retries',
            {
              error: lastError.message,
              attempt,
              maxRetries,
              note: 'Gas price likely increased since estimation. Re-adjustment needed.',
            },
          );

          // Don't retry - throw immediately so caller can detect and re-adjust
          throw lastError;
        }

        if (attempt < maxRetries) {
          // Exponential backoff: baseDelay * 2^(attempt-1)
          const delay = baseDelay * Math.pow(2, attempt - 1);

          this.logger.warn(
            `Retry attempt ${attempt}/${maxRetries} after ${delay}ms`,
            {
              error: error.message,
            },
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Operation failed after retries');
  }

  /**
   * Estimate transaction cost (gas/compute units) for cross-chain swap
   * For EVM source chains, estimates gas. For Solana, estimates compute units.
   * Delegates to GasEstimationService for centralized gas estimation logic.
   */
  protected async estimateTransactionCost(context: ExecutionContext): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;
    const sourceChainId = route.steps[0]?.chainId;
    const userWallet = context.request.userWallet;

    // CRITICAL: Determine ecosystem FIRST and log extensively for debugging
    const normalizedChainId = normalizeChainId(sourceChainId);
    const detectedEcosystem = this.detectEcosystem(sourceChainId);
    const isEVMChain = detectedEcosystem === 'evm';

    this.logger.log(
      '🔍 Estimating transaction cost - Ecosystem detection details',
      {
        sourceChainId,
        sourceChainIdType: typeof sourceChainId,
        normalizedChainId,
        normalizedType: typeof normalizedChainId,
        detectedEcosystem,
        isEVMChain,
        userWallet,
        aggregator: swapQuote.aggregator,
        note:
          detectedEcosystem !== 'evm'
            ? `Using ${detectedEcosystem}-specific gas estimation`
            : 'Using EVM gas estimation service',
      },
    );

    if (isEVMChain) {
      // EVM chain: use GasEstimationService
      if (this.gasEstimationService) {
        try {
          return await this.gasEstimationService.estimateTransactionCost(
            context,
            'evm',
          );
        } catch (error) {
          this.logger.warn(
            `GasEstimationService failed, checking for routeGasCostWei: ${error.message}`,
          );

          // Special case: Check for routeGasCostWei from Rubic (provider-specific)
          const routeGasCostWei = route.fees?.gasCostWei;
          const quoteGasLimit = swapQuote.gas || swapQuote.estimatedGas;

          if (
            routeGasCostWei &&
            routeGasCostWei !== '0' &&
            routeGasCostWei !== ''
          ) {
            // Use gasCostWei directly (already calculated by Rubic)
            // Apply historical usage adjustment factor from config
            const baseGasCost = BigInt(routeGasCostWei);
            const fallbackGasCost = (
              (baseGasCost *
                BigInt(this.gasConfig.margins.historicalUsagePercent)) /
              BigInt(100)
            ).toString();
            const fallbackGasLimit = quoteGasLimit || '300000';

            this.logger.log(
              'Using fallback gas estimation from route gasCostWei',
              {
                gasLimit: fallbackGasLimit,
                routeGasCostWei,
                originalGasCost: baseGasCost.toString(),
                adjustedGasCost: fallbackGasCost,
                historicalAdjustmentFactor: '77%',
                source: 'route.gasCostWei',
              },
            );

            this.logger.log(
              `Fallback gas estimation using route gasCostWei: ${context.request.routeId}`,
              JSON.stringify({
                routeId: context.request.routeId,
                routeProvider:
                  (route.providerRef as any)?.aggregator || 'unknown',
                routeGasCostWei,
                calculatedGasLimit: fallbackGasLimit,
                calculatedGasCost: fallbackGasCost,
                historicalAdjustmentFactor: '77%',
                chainId: normalizedChainId,
              }),
            );

            return {
              gasLimit: fallbackGasLimit,
              gasCost: fallbackGasCost,
            };
          }

          // Fallback to conservative estimate from route
          return await this.gasEstimationService.getConservativeGasEstimateFromRoute(
            context,
          );
        }
      }

      // Fallback if service is not available - use legacy method
      return await this.getConservativeGasEstimateFromRouteLegacy(context);
    } else {
      // Non-EVM chains: Solana, Tron, Bitcoin
      const normalizedStr = String(normalizedChainId).toLowerCase();
      const normalizedNum =
        typeof normalizedChainId === 'number'
          ? normalizedChainId
          : parseInt(String(normalizedChainId), 10);

      if (
        normalizedStr.includes('tron') ||
        normalizedStr === 'trx' ||
        normalizedNum === 195
      ) {
        // ========================================================================
        // TRON FEE SYSTEM EXPLANATION (different from EVM chains)
        // ========================================================================
        //
        // Tron does NOT use "gas" like EVM chains. Instead:
        // 1. BANDWIDTH: Consumed for ALL transactions based on size (bytes)
        //    - Cost: 1,000 SUN per byte when free bandwidth depleted
        //    - Free bandwidth: 600 units per day per account
        //    - Typical TRX transfer: 250-350 bytes = 250,000-350,000 SUN (0.25-0.35 TRX)
        //
        // 2. ENERGY: Only consumed for smart contract execution (TRC20, bridges, etc.)
        //    - Cost: 420 SUN per unit (fluctuates based on network)
        //    - Bridge contracts: 10,000-65,000 units = 4.2-27.3 TRX
        //
        // GAS RESERVE STRATEGY (based on transaction analysis):
        // - Simple TRX transfers (CEX deposits): 1.1 TRX (1,100,000 SUN)
        //   * Covers bandwidth + safety buffer
        //   * depositInfo-based trades from Rubic
        // - Bridge contract calls (cross-chain swaps): 5 TRX (5,000,000 SUN)
        //   * Covers bandwidth + energy for smart contracts
        //   * Direct Tron swaps without depositInfo
        // ========================================================================

        // Detect if this is a simple transfer (CEX deposit) or bridge contract call
        const swapQuote = route.providerRef as SwapQuote;
        const depositInfo = (swapQuote as any).depositInfo;
        const isSimpleTransfer = !!(
          depositInfo && depositInfo.transferEcosystem === 'tron'
        );

        let tronBandwidthCost: string;
        let costType: string;

        if (isSimpleTransfer) {
          // Simple TRX transfer to CEX deposit address (no smart contract)
          tronBandwidthCost = '1100000'; // 1.1 TRX in SUN (simple transfer cost)
          costType = 'simple-transfer';

          this.logger.log(
            'Tron simple transfer detected (CEX deposit), using 1.1 TRX reserve',
            {
              chainId: sourceChainId,
              depositAddress: depositInfo.depositAddress,
              transferType: 'native-trx-transfer',
              feeModel: 'bandwidth-only',
              bandwidthCostPerByte: '1,000 SUN',
              typicalTransferSize: '250-350 bytes',
              freeBandwidth: '600 units per day per account',
              estimatedCost: '1.1 TRX (1,100,000 SUN)',
              note: 'Simple TRX transfer to CEX deposit address - no smart contract interaction',
            },
          );
        } else {
          // Bridge contract call (requires energy for smart contract execution)
          tronBandwidthCost = this.chainFeeConfig.tron.typicalBridgeCost;
          costType = 'bridge-contract';

          this.logger.log(
            'Tron bridge contract call detected, using 5 TRX reserve',
            {
              chainId: sourceChainId,
              transferType: 'smart-contract-interaction',
              feeModel: 'bandwidth + energy',
              bandwidthCostPerByte: '1,000 SUN',
              energyCostPerUnit: '420 SUN',
              typicalTransferSize: '350 bytes',
              typicalEnergyUsage: '10,000-65,000 units for bridge contracts',
              freeBandwidth: '600 units per day per account',
              estimatedCost: '5 TRX (5,000,000 SUN)',
              breakdown: {
                bandwidth: '~350,000 SUN (0.35 TRX)',
                energy: '~4,200,000-27,300,000 SUN (4.2-27.3 TRX)',
                reserve: '5,000,000 SUN (5 TRX covers most bridge contracts)',
              },
              note: 'Bridge contract interaction requires energy costs for smart contract execution',
            },
          );
        }

        return {
          gasLimit: '1', // Tron doesn't use gas limit (uses bandwidth/energy limits)
          gasCost: tronBandwidthCost,
        };
      } else if (
        normalizedStr.includes('solana') ||
        normalizedStr.includes('sol')
      ) {
        // Solana - use dynamic estimation if transaction data is available
        this.logger.log(
          'Solana source chain detected, attempting dynamic gas estimation',
        );

        // Try to get transaction data from quote for simulation
        const transactionData =
          (swapQuote as any).transaction?.data ||
          (swapQuote as any).tx?.data ||
          (swapQuote as any).transactionData;

        try {
          // Call wallet service to estimate transaction cost
          // WalletService will route to the appropriate Solana provider
          const estimation =
            await this.walletService.estimateSolanaTransactionCost(
              sourceChainId,
              transactionData,
              userWallet,
            );

          this.logger.log('Dynamic Solana gas estimation successful', {
            computeUnits: estimation.computeUnits,
            priorityFee: estimation.priorityFee,
            totalCost: estimation.totalCost,
            source: transactionData ? 'simulation' : 'network-analysis',
          });

          return {
            gasLimit: estimation.computeUnits.toString(),
            gasCost: estimation.totalCost,
          };
        } catch (estimationError) {
          this.logger.warn(
            `Dynamic Solana estimation failed: ${estimationError.message}, using config fallback`,
          );
        }

        // Fallback to config values
        this.logger.log('Using config-based Solana gas estimate (fallback)');
        const solanaGasCost = this.chainFeeConfig.solana.totalGasCost;

        return {
          gasLimit: this.chainFeeConfig.solana.defaultComputeUnits.toString(),
          gasCost: solanaGasCost,
        };
      } else {
        // Bitcoin or other chains
        this.logger.log(
          'Non-EVM/non-Solana/non-Tron source chain detected, using default conservative estimate',
        );

        return {
          gasLimit: '1',
          gasCost: '100000', // Conservative default
        };
      }
    }
  } /**
   * Adjust swap amount by fetching new quote with adjusted amount
   */
  protected async adjustSwapAmount(
    context: ExecutionContext,
    adjustedAmount: string,
    gasCost: string,
  ): Promise<void> {
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;
    const sourceChainId = route.steps[0]?.chainId;
    const destChainId = route.steps[route.steps.length - 1]?.chainId;

    const loggedOriginalAmount =
      context.request.amountAdjustment?.originalAmount || swapQuote.sellAmount;
    const reservedAmount = loggedOriginalAmount
      ? (BigInt(loggedOriginalAmount) - BigInt(adjustedAmount)).toString()
      : '0';

    this.logger.log(
      `Fetching new cross-chain route with adjusted amount: ${context.request.routeId}`,
      JSON.stringify({
        routeId: context.request.routeId,
        routeProvider: swapQuote?.aggregator || 'unknown',
        originalAmount: loggedOriginalAmount,
        adjustedAmount,
        reserved: reservedAmount,
        gasCost,
        sourceChainId,
        destChainId,
        sellToken: swapQuote.sellToken,
        buyToken: swapQuote.buyToken,
      }),
    );

    this.logger.log('Fetching new cross-chain route with adjusted amount', {
      originalAmount: loggedOriginalAmount,
      adjustedAmount,
      sourceChainId,
      destChainId,
      sellToken: swapQuote.sellToken,
      buyToken: swapQuote.buyToken,
    });

    try {
      // Build route request with adjusted amount
      // CRITICAL: For aggregator APIs, we need numeric chainIds, not normalized strings
      // sourceChainId and destChainId might already be numeric (e.g., 195) or strings (e.g., "tron-mainnet")
      // If they're already numeric, use them directly. If strings, convert them back to numeric.
      const getNumericChainId = (chainId: string | number): number => {
        if (typeof chainId === 'number') return chainId;

        // Handle string chainIds - try to extract numeric ID
        const str = chainId.toString().toLowerCase();

        // Tron mappings
        if (str === 'tron-mainnet' || str === 'tron' || str === 'trx')
          return 195;

        // Solana mappings
        if (str === 'solana-mainnet' || str === 'solana' || str === 'sol')
          return 1151111081099710; // Rubic's Solana ID

        // Try parsing as number
        const parsed = parseInt(chainId.toString());
        if (!isNaN(parsed)) return parsed;

        // Fallback: throw error for unknown chains
        throw new Error(
          `Cannot convert chain identifier to numeric ID: ${chainId}`,
        );
      };

      const numericSourceChainId = getNumericChainId(sourceChainId);
      const numericDestChainId = getNumericChainId(destChainId);

      const routeRequest: RouteRequest = {
        fromChainId: numericSourceChainId,
        toChainId: numericDestChainId,
        fromToken: swapQuote.sellToken,
        toToken: swapQuote.buyToken,
        amount: adjustedAmount,
        userAddress: context.request.userWallet,
        recipient: context.request.recipient || context.request.userWallet, // CRITICAL: Required for cross-chain swaps
        slippageBps: context.request.slippageToleranceBps || 50, // Default 50 bps (0.5%)
      };

      // Fetch new routes
      const newRoutes =
        await this.aggregatorManager.getCrossChainRoutes(routeRequest);

      if (!newRoutes || newRoutes.length === 0) {
        throw new Error('No routes found with adjusted amount');
      }

      // Use the first route (best route)
      const newRoute = newRoutes[0];
      this.logger.log('New route fetched with adjusted amount', {
        newRoute,
      });

      // Update route with new route data
      route.providerRef = newRoute.providerRef;
      route.totalEstimatedOut = newRoute.totalEstimatedOut;
      route.minOutputAmount = newRoute.minOutputAmount;
      route.steps = newRoute.steps;

      // CRITICAL: For native token swaps, ensure sellAmount and value are consistent
      // The new quote's sellAmount should come from transaction.value (source of truth)
      // Both sellAmount and value should match the actual transaction value from Rubic API
      const newSwapQuote = newRoute.providerRef as any;
      if (
        newSwapQuote &&
        swapQuote.sellToken &&
        isNativeToken(swapQuote.sellToken)
      ) {
        // For native tokens, sellAmount should match transaction.value (both are set from transaction.value in convertAPIResponseToRouteQuote)
        // If there's a mismatch, use transaction.value as the source of truth
        if (
          newSwapQuote.value &&
          newSwapQuote.sellAmount &&
          newSwapQuote.value !== newSwapQuote.sellAmount
        ) {
          this.logger.warn(
            'sellAmount and value mismatch detected - using transaction.value as source of truth',
            {
              sellAmount: newSwapQuote.sellAmount,
              value: newSwapQuote.value,
              adjustedAmount,
              note: 'Updating sellAmount to match transaction.value for consistency',
            },
          );
          // Use transaction.value as source of truth (this is what will actually be sent)
          newSwapQuote.sellAmount = newSwapQuote.value;
          // Update the route's providerRef with the corrected sellAmount
          route.providerRef = newSwapQuote;
        } else if (!newSwapQuote.value && newSwapQuote.sellAmount) {
          // If value is missing but sellAmount exists, set value to match sellAmount
          this.logger.debug(
            'Setting value field to match sellAmount for native token',
            {
              sellAmount: newSwapQuote.sellAmount,
            },
          );
          newSwapQuote.value = newSwapQuote.sellAmount;
          route.providerRef = newSwapQuote;
        }

        // Validate that the new quote's sellAmount (from transaction.value) matches the requested adjustedAmount (within tolerance)
        // Rubic API may return transaction.value that differs slightly due to rounding or fee calculations
        const requestedAmount = BigInt(adjustedAmount);
        const decimalsForComparison = this.resolveSellTokenDecimals(
          newRoute,
          newSwapQuote,
        );
        const actualQuoteAmount = this.convertAmountStringToBaseUnits(
          newSwapQuote.sellAmount || newSwapQuote.value || '0',
          decimalsForComparison,
        );
        const difference =
          requestedAmount > actualQuoteAmount
            ? requestedAmount - actualQuoteAmount
            : actualQuoteAmount - requestedAmount;
        const differencePercent =
          requestedAmount > 0n
            ? (difference * BigInt(100)) / requestedAmount
            : BigInt(0);

        // Log the actual amounts being used
        // Winston logging: Log route update with amount validation
        this.logger.log(
          `Cross-chain route updated with adjusted amount (validated): ${context.request.routeId}`,
          JSON.stringify({
            routeId: context.request.routeId,
            routeProvider: swapQuote?.aggregator || 'unknown',
            requestedAdjustedAmount: adjustedAmount,
            quoteSellAmount: newSwapQuote.sellAmount,
            quoteValue: newSwapQuote.value,
            actualAmountUsed: actualQuoteAmount.toString(),
            difference: difference.toString(),
            differencePercent: differencePercent.toString() + '%',
            newOutputAmount: route.totalEstimatedOut,
            newMinOutputAmount: route.minOutputAmount,
            sourceChainId,
            destChainId,
            note: 'sellAmount comes from transaction.value (source of truth for actual transaction)',
          }),
        );

        this.logger.log('Cross-chain route updated with adjusted amount', {
          requestedAdjustedAmount: adjustedAmount,
          quoteSellAmount: newSwapQuote.sellAmount,
          quoteValue: newSwapQuote.value,
          actualAmountUsed: actualQuoteAmount.toString(),
          difference: difference.toString(),
          differencePercent: differencePercent.toString() + '%',
          note: 'sellAmount comes from transaction.value (source of truth for actual transaction)',
        });

        if (differencePercent > BigInt(1)) {
          // More than 1% difference
          this.logger.warn(
            'New cross-chain quote sellAmount differs significantly from requested adjusted amount',
            {
              requestedAdjustedAmount: adjustedAmount,
              quoteSellAmount: newSwapQuote.sellAmount,
              quoteValue: newSwapQuote.value,
              difference: difference.toString(),
              differencePercent: differencePercent.toString() + '%',
              note: 'Using quote sellAmount (from transaction.value) as it represents the actual transaction amount',
            },
          );
        } else if (difference > 0n) {
          // Small difference (within 1%) - log for debugging
          this.logger.debug(
            'New cross-chain quote sellAmount differs slightly from requested adjusted amount (within tolerance)',
            {
              requestedAdjustedAmount: adjustedAmount,
              quoteSellAmount: newSwapQuote.sellAmount,
              quoteValue: newSwapQuote.value,
              difference: difference.toString(),
              differencePercent: differencePercent.toString() + '%',
              note: 'Small difference likely due to Rubic API rounding or fee calculations',
            },
          );
        }
      }

      // Update routeId
      const originalRouteId = context.request.routeId;
      context.request.routeId = `${originalRouteId}_adjusted_${Date.now()}`;
      route.routeId = context.request.routeId;

      // Winston logging: Log successful route update
      const updatedSwapQuote = newRoute.providerRef as any;
      this.logger.log(
        `Cross-chain route updated with adjusted amount: ${context.request.routeId}`,
        JSON.stringify({
          originalRouteId,
          newRouteId: context.request.routeId,
          routeProvider: swapQuote?.aggregator || 'unknown',
          requestedAdjustedAmount: adjustedAmount,
          newSellAmount: updatedSwapQuote?.sellAmount,
          newValue: updatedSwapQuote?.value,
          newOutputAmount: route.totalEstimatedOut,
          newMinOutputAmount: route.minOutputAmount,
          sourceChainId,
          destChainId,
          note: 'New quote fetched with adjusted amount, route updated',
        }),
      );

      this.logger.log('Cross-chain route updated with adjusted amount', {
        newRouteId: context.request.routeId,
        newOutputAmount: route.totalEstimatedOut,
        newMinOutputAmount: route.minOutputAmount,
        newValue: (newRoute.providerRef as any)?.value,
        newSellAmount: (newRoute.providerRef as any)?.sellAmount,
      });
    } catch (error) {
      this.logger.error(
        'Failed to fetch new cross-chain route with adjusted amount',
        {
          error: error.message,
          stack: error.stack,
        },
      );
      throw new Error(
        `Failed to fetch new cross-chain route with adjusted amount: ${error.message}`,
      );
    }
  }

  /**
   * Get native token balance for a wallet
   */
  protected async getNativeTokenBalance(
    chainId: number | string,
    walletAddress: string,
  ): Promise<string> {
    try {
      const normalizedChainId = normalizeChainId(chainId);
      const ecosystem = this.detectEcosystem(normalizedChainId);

      // For EVM chains, force numeric chainId to keep viem providers happy
      const providerChainId =
        ecosystem === 'evm' && typeof normalizedChainId === 'string'
          ? parseInt(normalizedChainId, 10)
          : normalizedChainId;

      const balanceInfo = await this.walletService.getBalance(
        providerChainId,
        walletAddress,
        undefined,
        ecosystem,
      );

      return balanceInfo.balance || '0';
    } catch (error) {
      this.logger.error('Failed to get native token balance', {
        chainId,
        walletAddress,
        error: error.message,
      });
      throw new Error(`Failed to get native token balance: ${error.message}`);
    }
  }

  /**
   * Get gas price from network (Etherscan or RPC)
   * Used when route/quote gas price is missing or 0
   */
  protected async getGasPriceFromNetwork(
    chainId: number | string,
  ): Promise<string> {
    try {
      const normalizedChainId = normalizeChainId(chainId);
      const isEVMChain = typeof normalizedChainId === 'number';

      if (!isEVMChain) {
        // Non-EVM chains - use default
        this.logger.warn(
          'Gas price fetch not supported for non-EVM chain, using default',
          {
            chainId,
            defaultGasPrice: '20000000000', // 20 gwei default
          },
        );
        return '20000000000';
      }

      // Fetch gas price from network via walletService
      const feeData = await this.walletService.estimateFees(
        normalizedChainId,
        'evm',
      );

      let gasPrice: string;
      if (feeData.type === 'eip1559') {
        // For EIP-1559, use maxFeePerGas
        gasPrice = feeData.maxFeePerGas || '0';
      } else {
        // For legacy, use gasPrice
        gasPrice = feeData.gasPrice || '0';
      }

      // Validate gas price is not 0
      if (!gasPrice || gasPrice === '0' || BigInt(gasPrice) === 0n) {
        this.logger.warn(
          'Network returned gas price 0, using chain-specific default',
          {
            chainId: normalizedChainId,
            feeData,
          },
        );

        // Use chain-specific defaults as fallback
        if (normalizedChainId === 1) {
          return '30000000000'; // 30 gwei for Ethereum mainnet
        } else if (normalizedChainId === 56) {
          return '5000000000'; // 5 gwei for BSC
        } else if (normalizedChainId === 137) {
          return '50000000000'; // 50 gwei for Polygon
        } else {
          return '20000000000'; // 20 gwei generic default
        }
      }

      this.logger.log('Fetched gas price from network', {
        chainId: normalizedChainId,
        gasPrice,
        feeType: feeData.type,
      });

      return gasPrice;
    } catch (error) {
      this.logger.error('Failed to fetch gas price from network', {
        chainId,
        error: error.message,
      });

      // Use chain-specific defaults as fallback
      const normalizedChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;
      if (normalizedChainId === 1) {
        return '30000000000'; // 30 gwei for Ethereum mainnet
      } else if (normalizedChainId === 56) {
        return '5000000000'; // 5 gwei for BSC
      } else if (normalizedChainId === 137) {
        return '50000000000'; // 50 gwei for Polygon
      } else {
        return '20000000000'; // 20 gwei generic default
      }
    }
  }
}

// Enrich final result with bridge tracking fields and destination explorer link when available
// Override the Base hook
// Note: Placed after class definition to leverage class method, but TypeScript requires within class.
