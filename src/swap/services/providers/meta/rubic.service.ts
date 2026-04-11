import { Injectable, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { SDK, BLOCKCHAIN_NAME, Configuration, CHAIN_TYPE } from 'rubic-sdk';
import type { CrossChainTrade } from 'rubic-sdk';
import { CustomHttpService } from '@shared/services/http.service';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import {
  AmountNormalizationUtils,
  ProviderAmountFormat,
} from '@shared/utils/amount-normalization.utils';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  IMetaAggregator,
  RouteRequest,
  RouteQuote,
  ExecutionStatus,
  Step,
  ProviderConfig,
  ProviderHealth,
  IProvider,
} from '../../../models/ports';
import type { IAggregatorRegistry } from '@swap/services/core/aggregation/aggregator-registry.interface';
import { AggregatorManagerService } from '@swap/services/core/aggregation/aggregator-manager.service';
import {
  convertToProviderFormat,
  ProviderType,
} from '@shared/utils/token-address.utils';

/**
 * Rubic meta aggregator service
 * Aggregates 360+ DEXs, bridges & intent-based protocols across 70+ blockchains
 *
 * Key Features:
 * - Supports 15,500+ tokens
 * - Cross-chain swaps across EVM and non-EVM chains
 * - Zero protocol fees for swaps under $100
 * - Revenue sharing model for integrators
 */
@Injectable()
export class RubicService implements IMetaAggregator, IProvider, OnModuleInit {
  private sdk: SDK | null = null;
  private initializationPromise: Promise<void> | null = null;

  // Chain ID to Rubic API v2 chain ID mapping
  // Rubic API uses different IDs than standard chain IDs
  // Reference: https://api-v2.rubic.exchange/api/swagger/#/
  //
  // NOTE: Some chains in Rubic have id=null (LITECOIN, TON, CARDANO, etc.)
  // These chains are identified by blockchain NAME only in Rubic API
  // Our mapChainIdToBlockchainName() handles the name mapping for all chains
  private readonly chainIdToRubicChainId: Record<
    number | string,
    number | string
  > = {
    // EVM Chains
    1: 1, // Ethereum
    56: 56, // BSC
    137: 137, // Polygon
    43114: 43114, // Avalanche
    42161: 42161, // Arbitrum
    10: 10, // Optimism
    8453: 8453, // Base
    250: 250, // Fantom
    42220: 42220, // Celo
    100: 100, // Gnosis
    324: 324, // zkSync Era
    1101: 1101, // Polygon zkEVM
    59144: 59144, // Linea

    // Native L1 Chains with numeric IDs in Rubic
    'bitcoin-mainnet': 5555, // Bitcoin
    bitcoin: 5555, // Bitcoin (alternative)
    'solana-mainnet': 7565164, // Solana
    solana: 7565164, // Solana (alternative)
    195: 195, // Tron
    tron: 195, // Tron (alternative)
    'tron-mainnet': 195, // Tron canonical id

    // Chains with id=null in Rubic are not listed here
    // They are identified by blockchain name only (see mapChainIdToBlockchainName)
    // Examples: LITECOIN, TON, CARDANO, POLKADOT, HEDERA, DOGECOIN, etc.
  };

  // Chain ID to Rubic BLOCKCHAIN_NAME mapping (for SDK)
  private readonly chainIdToBlockchain: Record<number, string> = {
    1: BLOCKCHAIN_NAME.ETHEREUM,
    56: BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN,
    137: BLOCKCHAIN_NAME.POLYGON,
    43114: BLOCKCHAIN_NAME.AVALANCHE,
    42161: BLOCKCHAIN_NAME.ARBITRUM,
    10: BLOCKCHAIN_NAME.OPTIMISM,
    8453: BLOCKCHAIN_NAME.BASE,
    250: BLOCKCHAIN_NAME.FANTOM,
    42220: BLOCKCHAIN_NAME.CELO,
    100: BLOCKCHAIN_NAME.GNOSIS,
    1313161554: BLOCKCHAIN_NAME.AURORA,
    1666600000: BLOCKCHAIN_NAME.HARMONY,
    25: BLOCKCHAIN_NAME.CRONOS,
    1285: BLOCKCHAIN_NAME.MOONRIVER,
    1284: BLOCKCHAIN_NAME.MOONBEAM,
    5555: BLOCKCHAIN_NAME.BITCOIN,
    7565164: BLOCKCHAIN_NAME.SOLANA,
    195: BLOCKCHAIN_NAME.TRON,
  };

  // API Configuration Constants
  private readonly RUBIC_API_BASE_URL = 'https://api-v2.rubic.exchange';
  private readonly DEFAULT_API_TIMEOUT = 30000;
  private readonly SWAP_API_TIMEOUT = 15000;
  private readonly STATUS_API_TIMEOUT = 10000;

  // Gas Configuration Constants
  private readonly DEFAULT_CROSS_CHAIN_GAS_LIMIT = '500000';
  private readonly MIN_CROSS_CHAIN_GAS_LIMIT = 200000;
  private readonly MAX_GAS_LIMIT = 30_000_000; // Ethereum block gas limit
  private readonly SAFE_MAX_GAS_LIMIT = 2_000_000; // Safe cap for excessive gas estimates
  private readonly GAS_LIMIT_SAFETY_MARGIN = 1.2; // 20% buffer

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly envConfig: EnvironmentConfigService,
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly amountUtils: AmountNormalizationUtils,
    private readonly winstonLogger: WinstonLoggerService,
    @Optional()
    @Inject(AggregatorManagerService)
    private readonly registry?: IAggregatorRegistry,
  ) {
    this.winstonLogger.setContext(RubicService.name);
  }

  /**
   * Self-register with AggregatorManagerService on module initialization
   */
  async onModuleInit() {
    // Initialize SDK asynchronously
    this.initializationPromise = this.initializeSDK();

    if (this.registry) {
      // Rubic implements IMetaAggregator through getCrossChainRoutes
      this.registry.registerMetaAggregator(this as any);
      this.winstonLogger.debug(
        `✅ ${this.getProviderName()} self-registered as Meta aggregator`,
      );
    } else {
      this.winstonLogger.warn(
        `⚠️ ${this.getProviderName()} could not find registry to self-register`,
      );
    }
  }

  // ============================================================================
  // HELPER METHODS - API Communication
  // ============================================================================

  /**
   * Helper method to make POST requests to Rubic API with consistent headers and error handling
   */
  private async rubicApiPost(
    endpoint: string,
    data: any,
    timeout = this.DEFAULT_API_TIMEOUT,
  ): Promise<any> {
    const url = `${this.RUBIC_API_BASE_URL}${endpoint}`;
    this.winstonLogger.debug(`POST ${url}`);

    const response: any = await this.httpService.post(url, data, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout,
    });

    return response.data || response;
  }

  /**
   * Helper method to make GET requests to Rubic API with consistent headers and error handling
   */
  private async rubicApiGet(
    endpoint: string,
    timeout = this.DEFAULT_API_TIMEOUT,
  ): Promise<any> {
    const url = `${this.RUBIC_API_BASE_URL}${endpoint}`;
    this.winstonLogger.debug(`GET ${url}`);

    const response: any = await this.httpService.get(url, {
      timeout,
    });

    return response;
  }

  /**
   * Helper method to log audit events in consistent format
   */
  private logAuditEvent(action: string, data: any): void {
    this.winstonLogger.audit(action, {
      ...data,
      aggregator: 'Rubic',
      timestamp: new Date().toISOString(),
    });
  }

  // ============================================================================
  // HELPER METHODS - Validation
  // ============================================================================

  /**
   * Check if provider is deposit-based (CEX)
   * Deposit-based providers are cheaper, faster, and more reliable than contract-based
   */
  /**
   * Identifies deposit-based (CEX) providers
   * These providers use AML checks and may not return funds in case of compliance issues
   */
  private isDepositBasedProvider(providerType: string): boolean {
    if (!providerType) return false;

    const depositBasedProviders = [
      'changenow',
      'simpleswap',
      'changelly',
      'changehero',
      'exolix',
      'near_intents',
    ];

    return depositBasedProviders.some((provider) =>
      providerType.toLowerCase().includes(provider),
    );
  }

  /**
   * Check if provider should be blocked due to AML compliance risks
   * Blocks providers that may hold funds and not return them due to AML checks:
   * - ChangeNow: AML checks can block transactions
   * - SimpleSwap: AML checks can block transactions
   * - Changelly: AML checks can block transactions
   * - Exolix: AML checks can block transactions
   */
  private isProviderBlacklisted(providerType: string): boolean {
    if (!providerType) return false;

    // CRITICAL: These providers check AML and may not return funds
    const blacklistedProviders = [
      'changenow',
      'simpleswap',
      'changelly',
      'exolix',
    ];

    const providerLower = providerType.toLowerCase();
    return blacklistedProviders.some((provider) =>
      providerLower.includes(provider),
    );
  }

  /**
   * Check if provider uses smart contract-based execution
   * These are preferred over deposit-based as they don't hold funds and execute atomically
   */
  private isSmartContractBasedProvider(providerType: string): boolean {
    if (!providerType) return false;

    const contractBasedProviders = [
      'uniswap',
      'pancakeswap',
      'quickswap',
      'sushiswap',
      'curve',
      '1inch',
      '0x',
      'paraswap',
      'yieldyak',
      'aave',
      'dodo',
      'balancer',
      'bancor',
      'kyberswap',
      'ston',
      'defi',
    ];

    const providerLower = providerType.toLowerCase();
    return contractBasedProviders.some((provider) =>
      providerLower.includes(provider),
    );
  }

  /**
   * Validate transaction data completeness
   * Returns validation result including whether provider is a CEX (deposit-based)
   * or Solana (base64-encoded transaction)
   *
   * NOTE: Solana transactions have a different structure:
   * - EVM: { to, data, value }
   * - Solana: { data: "base64_encoded_serialized_transaction" }
   */
  private validateTransactionData(
    transaction: any,
    providerType: string,
    sourceBlockchain?: string,
  ): {
    isValid: boolean;
    isCEX: boolean;
    isSolana: boolean;
    error?: string;
  } {
    if (!transaction) {
      return {
        isValid: false,
        isCEX: false,
        isSolana: false,
        error: 'No transaction data provided',
      };
    }

    // ========================================
    // STEP 1: Check if provider is CEX FIRST
    // ========================================
    // CEX providers (ChangeNow, SimpleSwap, Changelly, etc.) don't provide transaction data
    // because they use deposit-based execution flow
    const isCEX = this.isDepositBasedProvider(providerType);

    // Detect blockchain type for proper return value
    const isSolanaChain =
      sourceBlockchain?.toUpperCase() === 'SOLANA' ||
      sourceBlockchain?.toUpperCase() === 'SOL';

    if (isCEX) {
      // CEX providers require deposit-based execution (no transaction data provided)
      // This applies to ALL chains (Solana, EVM, Bitcoin, etc.)
      return {
        isValid: false,
        isCEX: true,
        isSolana: isSolanaChain,
        error:
          'Deposit-based execution (CEX) requires manual transaction construction',
      };
    }

    // ========================================
    // STEP 2: Blockchain-specific validation
    // ========================================

    // Check if this is a Solana transaction
    // Solana transactions from Rubic API have only { data: "base64_string" }
    // Reference: https://docs.rubic.finance/rubic-api/rubic-api/integration-example/swaps-from-solana
    if (isSolanaChain) {
      // For Solana, we only need the 'data' field (base64-encoded transaction)
      const hasData = !!transaction.data;

      if (!hasData) {
        return {
          isValid: false,
          isCEX: false,
          isSolana: true,
          error: 'Missing Solana transaction data (base64-encoded)',
        };
      }

      // Validate it's a base64 string
      if (
        typeof transaction.data !== 'string' ||
        transaction.data.length === 0
      ) {
        return {
          isValid: false,
          isCEX: false,
          isSolana: true,
          error: 'Invalid Solana transaction data format',
        };
      }

      this.winstonLogger.debug(
        `✅ Solana transaction validated: base64 data length=${transaction.data.length}`,
      );

      return {
        isValid: true,
        isCEX: false,
        isSolana: true,
      };
    }

    // For EVM chains, validate standard transaction structure
    const hasTo = !!transaction.to;
    const hasData = !!transaction.data;

    if (!hasTo || !hasData) {
      return {
        isValid: false,
        isCEX: false,
        isSolana: false,
        error: `Missing EVM transaction fields: hasTo=${hasTo}, hasData=${hasData}`,
      };
    }

    return {
      isValid: true,
      isCEX: false,
      isSolana: false,
    };
  }

  /**
   * Extract quote timeout (in ms) from Rubic swap response.
   * Rubic returns timeout in **seconds** under swapResponse.quote.timeout.
   */
  private extractQuoteTimeoutMs(swapResponse: any): number | undefined {
    const rawTimeoutSeconds =
      swapResponse?.quote?.timeout ?? swapResponse?.timeout;
    if (rawTimeoutSeconds === undefined || rawTimeoutSeconds === null) {
      return undefined;
    }

    const seconds = Number(rawTimeoutSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }

    const timeoutMs = seconds * 1000;
    this.winstonLogger.debug(
      `Detected Rubic swap timeout (seconds -> ms): ${timeoutMs}ms from ${rawTimeoutSeconds}s`,
    );
    return timeoutMs;
  }

  private async getDepositTransactionData(
    quoteData: any,
    apiRequest: any,
    req: RouteRequest,
    srcTokenDecimals: number,
    sourceBlockchain: string,
  ): Promise<{
    transaction: { to: string; data: string; value: string; gasLimit?: string };
    depositInfo: any;
  }> {
    if (!req.userAddress) {
      throw new Error('User address is required to build deposit transaction');
    }

    const depositRequest = {
      ...apiRequest,
      id: quoteData.id,
      fromAddress: req.userAddress,
      enableChecks: false,
      receiver: apiRequest.receiverAddress || req.userAddress,
    };

    const depositData = await this.rubicApiPost(
      '/api/routes/swapDepositTrade',
      depositRequest,
      this.SWAP_API_TIMEOUT,
    );
    const depositTx = depositData?.transaction;

    if (!depositTx?.depositAddress || !depositTx?.amountToSend) {
      throw new Error('Deposit trade missing depositAddress or amountToSend');
    }

    const amountDecimal = depositTx.amountToSend.toString();
    const amountAtomic = this.amountUtils.normalizeAmount(
      amountDecimal,
      srcTokenDecimals,
      ProviderAmountFormat.WEI,
    );
    const normalizedBlockchain = sourceBlockchain?.toUpperCase?.();
    const isTronBlockchain = normalizedBlockchain === 'TRON';
    const isBitcoinBlockchain = normalizedBlockchain === 'BITCOIN';
    const isSolanaBlockchain =
      normalizedBlockchain === 'SOLANA' || normalizedBlockchain === 'SOL';

    // All blockchains use atomic units (SUN for Tron, satoshi for Bitcoin, lamports for Solana, wei for EVM)
    const transferValue = amountAtomic;

    const transaction = {
      to: depositTx.depositAddress,
      data:
        isTronBlockchain || isBitcoinBlockchain || isSolanaBlockchain
          ? ''
          : '0x',
      value: transferValue,
      gasLimit:
        !isTronBlockchain &&
        !isBitcoinBlockchain &&
        !isSolanaBlockchain &&
        depositTx.gasLimit
          ? depositTx.gasLimit.toString()
          : undefined,
    };

    const depositInfo = {
      depositAddress: depositTx.depositAddress,
      amountToSendDecimal: amountDecimal,
      amountToSendAtomic: amountAtomic,
      transferValue,
      exchangeId: depositTx.exchangeId,
      extraFields: depositTx.extraFields || null,
      destinationAddress:
        depositTx.destAddress ||
        depositTx.destinationAddress ||
        depositTx.receiver,
      raw: depositTx,
      providerType: quoteData.providerType,
      sourceBlockchain,
      transferEcosystem: isTronBlockchain
        ? 'tron'
        : isBitcoinBlockchain
          ? 'bitcoin'
          : isSolanaBlockchain
            ? 'solana'
            : 'evm',
    };

    return { transaction, depositInfo };
  }

  /**
   * Validate and sanitize gas limit value
   * Handles null/invalid values and applies safety margins
   */
  private validateAndSanitizeGasLimit(
    gasLimit: any,
    providerType: string,
  ): string {
    // Handle null or invalid gas limit
    if (
      !gasLimit ||
      gasLimit === 'null' ||
      gasLimit === null ||
      gasLimit === '0'
    ) {
      this.winstonLogger.debug(
        `⚠️ Provider ${providerType} didn't provide gasLimit, using fallback: ${this.DEFAULT_CROSS_CHAIN_GAS_LIMIT}`,
      );
      return this.DEFAULT_CROSS_CHAIN_GAS_LIMIT;
    }

    const gasLimitNum = parseInt(gasLimit);

    // Validate minimum gas limit
    if (gasLimitNum < this.MIN_CROSS_CHAIN_GAS_LIMIT) {
      this.winstonLogger.warn(
        `⚠️ Provider ${providerType} gasLimit ${gasLimit} too low, using ${this.MIN_CROSS_CHAIN_GAS_LIMIT} minimum`,
      );
      return this.MIN_CROSS_CHAIN_GAS_LIMIT.toString();
    }

    // Cap excessive gas limits
    if (gasLimitNum > this.MAX_GAS_LIMIT) {
      this.winstonLogger.error(
        `⚠️ Provider ${providerType} gasLimit ${gasLimit} exceeds block limit, capping to ${this.SAFE_MAX_GAS_LIMIT}`,
      );
      return this.SAFE_MAX_GAS_LIMIT.toString();
    }

    // Apply safety margin
    const withMargin = Math.floor(gasLimitNum * this.GAS_LIMIT_SAFETY_MARGIN);
    this.winstonLogger.debug(
      `✅ Provider ${providerType} gasLimit ${gasLimit} + ${(this.GAS_LIMIT_SAFETY_MARGIN - 1) * 100}% margin = ${withMargin}`,
    );

    return withMargin.toString();
  }

  /**
   * Initialize Rubic SDK with configuration
   * NOW USES UNIFIED_CHAINS configuration instead of environment variables
   */
  private async initializeSDK(): Promise<void> {
    try {
      // Get RPC URLs from unified configuration
      const ethereumRpcUrls =
        this.unifiedConfig.getChainConfiguration(1)?.rpcUrls || [];
      const bscRpcUrls =
        this.unifiedConfig.getChainConfiguration(56)?.rpcUrls || [];
      const polygonRpcUrls =
        this.unifiedConfig.getChainConfiguration(137)?.rpcUrls || [];
      const avalancheRpcUrls =
        this.unifiedConfig.getChainConfiguration(43114)?.rpcUrls || [];
      const arbitrumRpcUrls =
        this.unifiedConfig.getChainConfiguration(42161)?.rpcUrls || [];
      const optimismRpcUrls =
        this.unifiedConfig.getChainConfiguration(10)?.rpcUrls || [];
      const baseRpcUrls =
        this.unifiedConfig.getChainConfiguration(8453)?.rpcUrls || [];
      const solanaRpcUrls =
        this.unifiedConfig.getChainConfiguration('solana-mainnet')?.rpcUrls ||
        [];

      const config: Configuration = {
        rpcProviders: {
          [BLOCKCHAIN_NAME.ETHEREUM]: {
            rpcList: ethereumRpcUrls,
          },
          [BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN]: {
            rpcList: bscRpcUrls,
          },
          [BLOCKCHAIN_NAME.POLYGON]: {
            rpcList: polygonRpcUrls,
          },
          [BLOCKCHAIN_NAME.AVALANCHE]: {
            rpcList: avalancheRpcUrls,
          },
          [BLOCKCHAIN_NAME.ARBITRUM]: {
            rpcList: arbitrumRpcUrls,
          },
          [BLOCKCHAIN_NAME.OPTIMISM]: {
            rpcList: optimismRpcUrls,
          },
          [BLOCKCHAIN_NAME.BASE]: {
            rpcList: baseRpcUrls,
          },
          [BLOCKCHAIN_NAME.SOLANA]: {
            rpcList: solanaRpcUrls,
          },
        },
        // Integrator wallet address for fee collection
        providerAddress: this.envConfig.rubicFeeWallet
          ? {
              [CHAIN_TYPE.EVM]: {
                crossChain: this.envConfig.rubicFeeWallet,
                onChain: this.envConfig.rubicFeeWallet,
              },
            }
          : undefined,
      };

      this.sdk = await SDK.createSDK(config);
      this.winstonLogger.log('✅ Rubic SDK initialized successfully');
    } catch (error) {
      this.winstonLogger.error(
        `Failed to initialize Rubic SDK: ${error.message}`,
        error.stack,
      );

      // Audit log SDK initialization error
      this.winstonLogger.audit('AGGREGATOR_API_ERROR', {
        aggregator: 'Rubic',
        context: 'SDK_initialization',
        errorType: this.categorizeError(error),
        errorMessage: error.message,
        timestamp: new Date().toISOString(),
      });

      throw error;
    }
  }

  /**
   * Ensure SDK is initialized before use
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }

    if (!this.sdk) {
      throw new Error('Rubic SDK not initialized');
    }
  }

  /**
   * Get provider name for identification
   */
  getProviderName(): string {
    return 'Rubic';
  }

  /**
   * Check if Rubic supports a specific chain for on-chain swaps
   * Rubic supports 70+ blockchains including all major EVM and native L1 chains
   * Implementation of IMetaAggregator.supportsChain
   */
  supportsChain(chainId: number): boolean {
    // Rubic supports a broad range of chains via its SDK and API v2
    // Check if chain is in our mapping (which covers 70+ supported chains)
    const supported =
      this.chainIdToRubicChainId.hasOwnProperty(chainId) ||
      this.chainIdToBlockchain.hasOwnProperty(chainId) ||
      // Also support chains by name for native L1 chains
      [
        1,
        56,
        137,
        43114,
        42161,
        10,
        8453,
        250,
        42220,
        100,
        324,
        1101,
        59144,
        195,
        7565164,
        5555, // Tron, Bitcoin, Solana
        1313161554,
        1666600000,
        25,
        1285,
        1284, // Aurora, Harmony, Cronos, etc.
        70,
        9001,
        1088,
        169,
        1088,
        1286,
        32659,
        14,
        148,
        1890,
        1891,
        122,
        108,
        1313161554,
      ].includes(chainId);

    return supported;
  }

  /**
   * Get available cross-chain routes using Rubic SDK or API v2
   * Implementation of IMetaAggregator.getRoutes
   *
   * Strategy: Try SDK first for all swaps, fallback to API v2 if SDK fails
   * - Primary: Rubic SDK (for EVM and cross-chain swaps)
   * - Fallback: Rubic API v2 (when SDK fails or for native L1 chains)
   */
  async getRoutes(req: RouteRequest): Promise<RouteQuote[]> {
    const startTime = Date.now();
    await this.ensureInitialized();
    // Fallback to API v2
    try {
      this.winstonLogger.debug(`Attempting Rubic API v2 for route calculation`);
      const routes = await this.getRoutesViaAPI(req);
      this.winstonLogger.log(
        `✅ Rubic API v2 succeeded with ${routes.length} route(s)`,
      );

      // Audit log success with API method
      const duration = Date.now() - startTime;
      this.winstonLogger.audit('AGGREGATOR_QUOTE_SUCCESS', {
        aggregator: 'Rubic',
        method: 'API',
        chainIdFrom: req.fromChainId,
        chainIdTo: req.toChainId,
        tokenFrom: req.fromToken,
        tokenTo: req.toToken,
        amountFrom: req.amount,
        routesCount: routes.length,
        isCrossChain: req.fromChainId !== req.toChainId,
        fallbackReason: 'SDKFailure',
        duration,
        timestamp: new Date().toISOString(),
      });

      return routes;
    } catch (apiError) {
      const duration = Date.now() - startTime;
      this.winstonLogger.error(
        `Both Rubic API v2 failed., API error: ${apiError.message}`,
      );

      // Audit log failure
      this.winstonLogger.audit('AGGREGATOR_QUOTE_FAILED', {
        aggregator: 'Rubic',
        chainIdFrom: req.fromChainId,
        chainIdTo: req.toChainId,
        tokenFrom: req.fromToken,
        tokenTo: req.toToken,
        amountFrom: req.amount,
        sdkError: 'SDKFailure',
        apiError: apiError.message,
        errorType: this.categorizeError(apiError),
        duration,
        timestamp: new Date().toISOString(),
      });

      throw new Error(
        `Rubic route calculation failed:, API (${apiError.message})`,
      );
    }
  }

  /**
   * Check if a chain ID is a native L1 chain (non-EVM)
   */
  private isNativeL1Chain(chainId: number | string): boolean {
    return typeof chainId === 'string' && isNaN(Number(chainId));
  }

  /**
   * Get routes using Rubic API v2 (for native L1 chains)
   * API Documentation: https://docs.rubic.finance/rubic-api/rubic-api/request-quote
   * Endpoint: POST /api/routes/quoteBest or /api/routes/quoteAll
   */
  private async getRoutesViaAPI(req: RouteRequest): Promise<RouteQuote[]> {
    // Map chain IDs to Rubic blockchain names
    const fromBlockchain = this.mapChainIdToBlockchainName(req.fromChainId);
    const toBlockchain = this.mapChainIdToBlockchainName(req.toChainId);

    this.winstonLogger.debug(
      `Rubic API v2: ${fromBlockchain} → ${toBlockchain}`,
    );

    // Get native token addresses
    const srcTokenAddress = this.getNativeTokenAddress(
      fromBlockchain,
      req.fromToken,
    );
    const dstTokenAddress = this.getNativeTokenAddress(
      toBlockchain,
      req.toToken,
    );

    // Get token decimals for accurate amount formatting
    // Use token symbol if available for efficient lookup from unified config
    const srcTokenDecimals = this.getTokenDecimals(
      srcTokenAddress,
      req.fromChainId,
      req.fromTokenSymbol,
    );

    this.winstonLogger.debug(
      `Source token ${req.fromTokenSymbol || srcTokenAddress} on chain ${req.fromChainId} has ${srcTokenDecimals} decimals`,
    );

    // Build API request - matches Rubic's working example format exactly
    // Reference: https://docs.rubic.finance/rubic-api/rubic-api/request-quote
    const apiRequest: any = {
      srcTokenBlockchain: fromBlockchain,
      srcTokenAddress,
      srcTokenAmount: this.amountUtils.normalizeForProvider(
        req.amount,
        srcTokenDecimals,
        'Rubic',
        'getRoutesV2',
      ), // Must be decimal string like "1.05"
      dstTokenBlockchain: toBlockchain,
      dstTokenAddress,
      referrer: 'rubic.exchange',
    };

    // Add optional parameters only if provided
    if (req.slippageBps) {
      apiRequest.slippageTolerance = req.slippageBps / 100; // Convert basis points to percentage
    }

    if (req.userAddress) {
      apiRequest.fromAddress = req.userAddress;
    }

    // CRITICAL: Always include receiverAddress if recipient is specified
    // Even if recipient === userAddress, Rubic needs this for proper routing
    // Removing this check prevents transaction reverts when swapping to same wallet
    if (req.recipient) {
      apiRequest.receiverAddress = req.recipient;
    }
    this.winstonLogger.log(
      JSON.stringify(apiRequest, null, 2),
      'API Request Rubic:',
    );
    this.winstonLogger.debug(
      'Rubic API v2 request:',
      JSON.stringify(apiRequest, null, 2),
    );

    try {
      // Ensure user address is provided upfront
      if (!req.userAddress) {
        throw new Error(
          'User address is required to fetch transaction data from Rubic',
        );
      }

      // STEP 1: Get ALL quotes from Rubic API v2
      // Call quoteAll endpoint instead of quoteBest to get multiple options
      // Returns: array of { estimate, fees, routing, providerType, swapType, id, transaction: { approvalAddress } }
      this.winstonLogger.debug('Fetching all quotes from Rubic API v2...');

      const responseData = await this.rubicApiPost(
        '/api/routes/quoteAll',
        apiRequest,
        this.DEFAULT_API_TIMEOUT,
      );

      // quoteAll returns: { quote: {...}, routes: [...], failed: [...] }
      // We need the routes array
      const allQuotes = responseData.routes || [];
      const failedProviders = responseData.failed || [];

      if (!Array.isArray(allQuotes)) {
        throw new Error(
          'Invalid response structure from Rubic API v2 quoteAll',
        );
      }

      if (allQuotes.length === 0) {
        const failedMsg =
          failedProviders.length > 0
            ? ` Failed providers: ${failedProviders.join(', ')}`
            : '';
        throw new Error(
          `Rubic API v2 returned no available routes.${failedMsg}`,
        );
      }

      this.winstonLogger.log(
        `📊 Rubic API v2 returned ${allQuotes.length} quote(s)` +
          (failedProviders.length > 0
            ? `, ${failedProviders.length} provider(s) failed`
            : ''),
      );

      // STEP 2: Fetch transaction data ONLY for the first valid quote (optimization)
      // Previously we fetched for ALL quotes, which took 26-28 seconds
      // Now we only fetch for the best quote to reduce time to ~3-5 seconds
      const successfulRoutes: RouteQuote[] = [];
      const failedQuotes: Array<{ provider: string; error: string }> = [];

      // Add providers that failed at the API level (from failed array)
      if (failedProviders.length > 0) {
        this.winstonLogger.debug(
          `Providers failed at API level: ${failedProviders.join(', ')}`,
        );
        failedProviders.forEach((provider) => {
          failedQuotes.push({
            provider: provider,
            error: 'failed at API level (no quote returned)',
          });
        });
      }

      // Sort quotes with priority:
      // 1. Deposit-based/CEX quotes (cheaper, faster, more reliable)
      // 2. Contract-based quotes (higher priority by output amount)
      const sortedQuotes = [...allQuotes]
        .filter((quote) => {
          // BLOCK blacklisted AML providers
          if (this.isProviderBlacklisted(quote.providerType)) {
            this.winstonLogger.warn(
              `🚫 Blocking blacklisted AML provider: ${quote.providerType}`,
            );
            failedQuotes.push({
              provider: quote.providerType,
              error: 'Blocked: AML compliance risk (fund hold)',
            });
            return false;
          }
          return true;
        })
        .sort((a, b) => {
          // Prioritize smart contract-based providers over deposit-based
          const aIsContract = this.isSmartContractBasedProvider(a.providerType);
          const bIsContract = this.isSmartContractBasedProvider(b.providerType);

          // Contract-based is preferred
          if (aIsContract && !bIsContract) return -1;
          if (!aIsContract && bIsContract) return 1;

          // Sort by output amount (best first)
          const aOutput = parseFloat(a.estimate?.dstAmount || '0');
          const bOutput = parseFloat(b.estimate?.dstAmount || '0');
          return bOutput - aOutput;
        });

      // Log sorting results
      const sortingSummary = sortedQuotes
        .map((q) => {
          const isContract = this.isSmartContractBasedProvider(q.providerType);
          const type = isContract ? '📜Contract' : '💰CEX';
          return `${type}:${q.providerType}(${q.estimate?.dstAmount || '0'})`;
        })
        .join(', ');

      this.winstonLogger.debug(
        `📊 Sorted quotes (Contract FIRST, AML-risky BLOCKED): ${sortingSummary}`,
      );

      for (const quoteData of sortedQuotes) {
        // Skip quotes with errors
        if (quoteData.error) {
          const errorMsg =
            quoteData.error.reason ||
            quoteData.error.message ||
            'Unknown error';
          this.winstonLogger.warn(`Skipping quote with error: ${errorMsg}`);
          failedQuotes.push({
            provider: quoteData.providerType || 'unknown',
            error: errorMsg,
          });
          continue;
        }

        // Log warnings if present
        if (quoteData.warnings && quoteData.warnings.length > 0) {
          this.winstonLogger.warn(
            `Quote warnings: ${JSON.stringify(quoteData.warnings)}`,
          );
        }

        // Validate required fields
        if (!quoteData.estimate || !quoteData.id) {
          this.winstonLogger.warn(`Skipping quote: missing estimate or ID`);
          failedQuotes.push({
            provider: quoteData.providerType || 'unknown',
            error: 'missing estimate or ID',
          });
          continue;
        }

        // Try to fetch transaction data for this quote
        try {
          this.winstonLogger.debug(
            `Fetching transaction data for quote: ${quoteData.providerType} (ID: ${quoteData.id})`,
          );

          // Build swap request to get transaction data
          const swapRequest = {
            ...apiRequest,
            id: quoteData.id,
            fromAddress: req.userAddress,
            enableChecks: false,
            receiver: apiRequest.receiverAddress,
          };

          // Call swap endpoint to get transaction data
          const swapData = await this.rubicApiPost(
            '/api/routes/swap',
            swapRequest,
            this.SWAP_API_TIMEOUT,
          );
          let transactionData = swapData.transaction;
          const quoteTimestamp = Date.now();
          const timeoutMs = this.extractQuoteTimeoutMs(swapData);
          const quoteExpiresAt = timeoutMs
            ? quoteTimestamp + timeoutMs
            : undefined;
          let validation = this.validateTransactionData(
            transactionData,
            quoteData.providerType,
            fromBlockchain,
          );
          let depositInfo: any;

          if (!validation.isValid && validation.isCEX) {
            try {
              const depositResult = await this.getDepositTransactionData(
                quoteData,
                apiRequest,
                req,
                srcTokenDecimals,
                fromBlockchain,
              );

              transactionData = depositResult.transaction;
              depositInfo = depositResult.depositInfo;
              validation = {
                isValid: true,
                isCEX: true,
                isSolana: false,
              };

              this.winstonLogger.debug(
                `✅ Converted deposit-based route for provider ${quoteData.providerType} into executable transaction`,
              );
              if (depositInfo) {
                this.winstonLogger.debug(
                  `📬 Deposit execution parameters | address=${depositInfo.depositAddress} | amount=${depositInfo.transferValue} | ecosystem=${depositInfo.transferEcosystem} | exchangeId=${depositInfo.exchangeId}`,
                );
              }
            } catch (depositError) {
              this.winstonLogger.warn(
                `⚠️ Deposit execution setup failed for ${quoteData.providerType}: ${depositError.message}`,
              );
              failedQuotes.push({
                provider: quoteData.providerType,
                error: depositError.message,
              });
              continue;
            }
          }

          if (!validation.isValid) {
            if (validation.isSolana) {
              this.winstonLogger.warn(
                `⚠️ Solana transaction validation failed: ${validation.error}`,
              );
            } else {
              this.winstonLogger.warn(
                `⚠️ Quote ${quoteData.providerType} has incomplete transaction data - ${validation.error}`,
              );
            }
            failedQuotes.push({
              provider: quoteData.providerType,
              error: validation.error || 'Unknown validation error',
            });
            continue;
          }

          if (validation.isSolana) {
            this.winstonLogger.debug(
              `✅ Solana transaction data fetched: ` +
                `base64DataLength=${transactionData.data.length}, provider=${quoteData.providerType}`,
            );
          } else {
            const ecosystemLabel =
              depositInfo?.transferEcosystem === 'tron' ? 'Tron' : 'EVM';
            this.winstonLogger.debug(
              `✅ ${ecosystemLabel} transaction data fetched: ` +
                `to=${transactionData.to}, dataLength=${transactionData.data?.length || 0}, value=${transactionData.value}, provider=${quoteData.providerType}`,
            );
          }

          // Combine quote data with transaction data
          const combinedData = {
            ...quoteData,
            transaction: transactionData,
            isDepositTrade: !!depositInfo,
            depositInfo,
            quoteTimestamp,
            quoteExpiresAt,
            timeoutMs,
          };

          // Convert to RouteQuote format
          const route = await this.convertAPIResponseToRouteQuote(
            combinedData,
            req,
          );
          successfulRoutes.push(route);

          this.winstonLogger.log(
            `✅ Successfully processed route: ${quoteData.providerType} (${quoteData.swapType})`,
          );

          // OPTIMIZATION: Only fetch transaction data for the FIRST successful quote
          // This reduces quote fetching time from 26-28s to ~3-5s
          this.winstonLogger.log(
            `🎯 Using best quote from ${quoteData.providerType}, skipping remaining ${sortedQuotes.length - sortedQuotes.indexOf(quoteData) - 1} quote(s)`,
          );
          break; // Exit loop after first successful quote
        } catch (txError) {
          this.winstonLogger.warn(
            `Failed to fetch transaction data for ${quoteData.providerType}: ${txError.message}`,
          );
          failedQuotes.push({
            provider: quoteData.providerType,
            error: txError.message,
          });
          continue; // Try next quote
        }
      }

      // Log summary
      this.winstonLogger.log(
        `📈 Rubic API v2 Results: ${successfulRoutes.length} successful, ${failedQuotes.length} failed`,
      );

      if (failedQuotes.length > 0) {
        this.winstonLogger.debug(
          `Failed quotes: ${failedQuotes.map((f) => `${f.provider} (${f.error})`).join(', ')}`,
        );
      }

      // Return all successful routes
      if (successfulRoutes.length === 0) {
        const totalAttempts = allQuotes.length + failedProviders.length;
        throw new Error(
          `No valid routes available. Tried ${totalAttempts} provider(s): ` +
            `${allQuotes.length} returned quotes but failed transaction fetch, ` +
            `${failedProviders.length} failed at API level. ` +
            `Failures: ${failedQuotes.map((f) => f.provider).join(', ')}`,
        );
      }

      return successfulRoutes;
    } catch (error) {
      this.winstonLogger.error(`Rubic API v2 failed: ${error.message}`);

      // Audit log API error using helper
      this.logAuditEvent('AGGREGATOR_API_ERROR', {
        context: 'getRoutesViaAPI',
        errorType: this.categorizeError(error),
        statusCode: error?.response?.status || error?.statusCode,
        errorMessage: error.message,
      });

      throw error;
    }
  }

  /**
   * Map chain ID to Rubic blockchain name
   * Rubic uses blockchain names like "ETH", "BSC", "BITCOIN", "SOLANA", "LITECOIN"
   *
   * NOTE: Some chains in Rubic have numeric IDs (e.g., BITCOIN=5555, SOLANA=7565164)
   * while others have id=null (e.g., LITECOIN, TON, CARDANO). We map our internal
   * chain IDs to Rubic's blockchain NAMES, not their numeric IDs.
   */
  private mapChainIdToBlockchainName(chainId: number | string): string {
    const mapping: Record<number | string, string> = {
      // EVM Chains (with numeric IDs)
      1: 'ETH',
      56: 'BSC',
      137: 'POLYGON',
      43114: 'AVALANCHE',
      42161: 'ARBITRUM',
      10: 'OPTIMISM',
      8453: 'BASE',
      250: 'FANTOM',
      42220: 'CELO',
      100: 'GNOSIS',
      324: 'ZK_SYNC',
      1101: 'POLYGON_ZKEVM',
      59144: 'LINEA',
      5000: 'MANTLE',
      534352: 'SCROLL',
      81457: 'BLAST',
      1284: 'MOONBEAM',
      1285: 'MOONRIVER',
      1088: 'METIS',
      1313161554: 'AURORA',
      1666600000: 'HARMONY',

      // Native L1 Chains with numeric IDs in Rubic
      5555: 'BITCOIN',
      7565164: 'SOLANA',
      195: 'TRON',

      // Native L1 Chains - String-based chain IDs (map to Rubic blockchain names)
      // These chains have id=null in Rubic API but are identified by name
      'bitcoin-mainnet': 'BITCOIN',
      bitcoin: 'BITCOIN',
      btc: 'BITCOIN',

      'litecoin-mainnet': 'LITECOIN',
      litecoin: 'LITECOIN',
      ltc: 'LITECOIN',

      'dogecoin-mainnet': 'DOGECOIN',
      dogecoin: 'DOGECOIN',
      doge: 'DOGECOIN',

      'solana-mainnet': 'SOLANA',
      solana: 'SOLANA',
      sol: 'SOLANA',

      'ton-mainnet': 'TON',
      ton: 'TON',

      'cardano-mainnet': 'CARDANO',
      cardano: 'CARDANO',
      ada: 'CARDANO',

      'polkadot-mainnet': 'POLKADOT',
      polkadot: 'POLKADOT',
      dot: 'POLKADOT',

      'hedera-mainnet': 'HEDERA',
      hedera: 'HEDERA',
      hbar: 'HEDERA',

      'xrpl-mainnet': 'RIPPLE',
      xrpl: 'RIPPLE',
      ripple: 'RIPPLE',
      xrp: 'RIPPLE',

      'tezos-mainnet': 'TEZOS',
      tezos: 'TEZOS',
      xtz: 'TEZOS',

      'cosmos-mainnet': 'COSMOS',
      cosmos: 'COSMOS',
      atom: 'COSMOS',

      'near-mainnet': 'NEAR',
      near: 'NEAR',

      'algorand-mainnet': 'ALGORAND',
      algorand: 'ALGORAND',
      algo: 'ALGORAND',

      'stellar-mainnet': 'STELLAR',
      stellar: 'STELLAR',
      xlm: 'STELLAR',

      'monero-mainnet': 'MONERO',
      monero: 'MONERO',
      xmr: 'MONERO',

      'zcash-mainnet': 'ZCASH',
      zcash: 'ZCASH',
      zec: 'ZCASH',

      'kusama-mainnet': 'KUSAMA',
      kusama: 'KUSAMA',
      ksm: 'KUSAMA',

      'flow-mainnet': 'FLOW',
      flow: 'FLOW',

      'aptos-mainnet': 'APTOS',
      aptos: 'APTOS',
      apt: 'APTOS',

      'sui-mainnet': 'SUI',
      sui: 'SUI',

      tron: 'TRON',
      trx: 'TRON',
      'tron-mainnet': 'TRON',
    };

    const blockchainName = mapping[chainId];
    if (!blockchainName) {
      throw new Error(
        `Unsupported chain ID for Rubic API: ${chainId}. ` +
          `Rubic supports: EVM chains (ETH, BSC, POLYGON, ARBITRUM, etc.), ` +
          `Native L1 (BITCOIN, LITECOIN, SOLANA, TON, CARDANO, POLKADOT, etc.). ` +
          `Please check rubic.json for the complete list of supported chains.`,
      );
    }

    return blockchainName;
  }

  /**
   * Get native token address for Rubic API
   * Handles different blockchain-specific address formats:
   * - EVM chains: 0x0000... for native tokens
   * - SUI chain: Module path format (e.g., 0x0000...0002::sui::SUI for native SUI)
   * - Other chains: Standard address formats
   */
  private getNativeTokenAddress(
    blockchain: string,
    tokenAddress: string,
  ): string {
    // Special handling for SUI blockchain
    if (blockchain === 'SUI') {
      // Check if it's already in SUI module path format (contains ::)
      if (tokenAddress && tokenAddress.includes('::')) {
        return tokenAddress;
      }

      // Check if it's a native token identifier
      const isNativeToken =
        !tokenAddress ||
        tokenAddress.toLowerCase() === 'native' ||
        tokenAddress.toLowerCase() === 'sui' ||
        tokenAddress.toLowerCase() ===
          '0x0000000000000000000000000000000000000000' ||
        tokenAddress.toLowerCase() ===
          '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

      if (isNativeToken) {
        // Return SUI native token in module path format
        return '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      }

      // For non-native SUI tokens, if it's a regular hex address, it might need to be in module format
      // In this case, we return as-is and expect the caller to provide the correct module path
      return tokenAddress;
    }

    // Special handling for Solana blockchain
    if (blockchain === 'SOLANA') {
      // Solana native SOL uses its own address format, not EVM format
      // Return the Solana address as-is (So11111111111111111111111111111111111111111 for native SOL)
      // Or any SPL token address
      if (tokenAddress && tokenAddress.length > 32) {
        return tokenAddress;
      }

      // If no address or generic native identifier, return SOL's wrapped address
      const isNativeToken =
        !tokenAddress ||
        tokenAddress.toLowerCase() === 'native' ||
        tokenAddress.toLowerCase() === 'sol';

      if (isNativeToken) {
        return 'So11111111111111111111111111111111111111111'; // Wrapped SOL
      }

      return tokenAddress;
    }

    // For non-SUI and non-Solana blockchains, use standard logic
    // If already a valid non-native address (42 chars, not eeee or 0000), return it
    if (
      tokenAddress &&
      tokenAddress.startsWith('0x') &&
      tokenAddress.length === 42 &&
      !tokenAddress
        .toLowerCase()
        .includes('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') &&
      tokenAddress.toLowerCase() !==
        '0x0000000000000000000000000000000000000000'
    ) {
      return tokenAddress;
    }

    // Convert to Rubic's required format (0x0000... for native tokens on EVM chains)
    return convertToProviderFormat(
      tokenAddress || 'native',
      ProviderType.RUBIC,
    );
  }

  /**
   * Get token decimals from unified configuration
   * Uses efficient symbol-based lookup when available, falls back to address matching
   *
   * @param tokenAddress - Token address (can be hex address or SUI module path)
   * @param chainId - Chain ID where token is deployed
   * @param tokenSymbol - Optional token symbol for efficient lookup
   * @returns Number of decimals for the token
   */
  private getTokenDecimals(
    tokenAddress: string,
    chainId: number | string,
    tokenSymbol?: string,
  ): number {
    // Delegate to unified configuration for consistent behavior across providers
    return this.unifiedConfig.getTokenDecimals(
      tokenAddress,
      chainId,
      tokenSymbol,
    );
  }

  /**
   * Convert Rubic API v2 response to RouteQuote format
   *
   * Handles both EVM and Solana transaction formats:
   * - EVM: { to, data, value, approvalAddress }
   * - Solana: { data: "base64_encoded_transaction" }
   *
   * Flow:
   * 1. quoteBest returns: { estimate, fees, routing, providerType, swapType, id, transaction: { approvalAddress } }
   * 2. swap returns: { transaction: { to, data, value, approvalAddress } } for EVM
   *                  { transaction: { data } } for Solana (base64-encoded)
   *
   * Combined response structure:
   * {
   *   estimate: { destinationTokenAmount, destinationWeiAmount, durationInMinutes, priceImpact, slippage },
   *   fees: { gasTokenFees, percentFees },
   *   transaction: { to, data, value, approvalAddress } | { data },
   *   routing: [{ path, provider, type }],
   *   providerType: string,
   *   swapType: string,
   *   id: string
   * }
   */
  private async convertAPIResponseToRouteQuote(
    apiResponse: any,
    req: RouteRequest,
  ): Promise<RouteQuote> {
    // Extract key data from response
    const estimate = apiResponse.estimate;
    const routing = apiResponse.routing?.[0]; // First route
    const fees = apiResponse.fees;
    const transaction = apiResponse.transaction; // Transaction data from /swap endpoint
    const isDepositTrade = !!apiResponse.isDepositTrade;
    const depositInfo = apiResponse.depositInfo;
    const quoteTimestamp = apiResponse.quoteTimestamp || Date.now();
    const timeoutMs = apiResponse.timeoutMs;
    const quoteExpiresAt =
      apiResponse.quoteExpiresAt ||
      (timeoutMs ? quoteTimestamp + timeoutMs : undefined);

    // Detect if this is a Solana transaction
    const sourceBlockchain = this.mapChainIdToBlockchainName(req.fromChainId);
    const isSolanaSwap =
      sourceBlockchain === 'SOLANA' || sourceBlockchain === 'SOL';

    // Rubic API doesn't return token info in response, use request data
    const tokens = {
      from: {
        address: req.fromToken,
        amount: transaction?.value || '0',
        blockchain: sourceBlockchain,
      },
      to: {
        address: req.toToken,
        blockchain: this.mapChainIdToBlockchainName(req.toChainId),
      },
    };

    // Log transaction data for debugging based on blockchain type
    if (transaction) {
      if (isSolanaSwap) {
        this.winstonLogger.debug(
          `Rubic Solana transaction data: base64Length=${transaction.data?.length || 0}`,
        );

        // Validate Solana transaction has data field
        if (!transaction.data) {
          this.winstonLogger.error(
            `⚠️ Rubic Solana transaction missing base64 data field`,
          );
        }
      } else {
        this.winstonLogger.debug(
          `Rubic EVM transaction data: to=${transaction.to}, ` +
            `dataLength=${transaction.data?.length || 0}, value=${transaction.value}`,
        );

        // Validate EVM transaction has required fields
        if (!transaction.to || !transaction.data) {
          this.winstonLogger.error(
            `⚠️ Rubic EVM transaction missing required fields: ` +
              `hasTo=${!!transaction.to}, hasData=${!!transaction.data}, hasValue=${!!transaction.value}`,
          );
        }
      }
    } else {
      this.winstonLogger.warn(
        '⚠️ No transaction data in Rubic API response - this may cause execution failure',
      );
    }

    // Extract steps from routing information
    const steps: Step[] = [];

    if (routing && routing.path) {
      // Create steps based on the routing path
      routing.path.forEach((pathStep: any, index: number) => {
        const isLast = index === routing.path.length - 1;

        // Create a clean step object without any circular references
        const step: Step = {
          kind: routing.type === 'cross-chain' ? 'bridge' : 'swap',
          chainId: pathStep.blockchainId || req.fromChainId,
          details: {
            fromToken:
              index > 0 ? routing.path[index - 1].address : pathStep.address,
            toToken: pathStep.address,
            fromAmount:
              index > 0 ? routing.path[index - 1].amount : tokens.from.amount,
            toAmount: pathStep.amount,
            blockchain: pathStep.blockchain,
            isDeposit: isDepositTrade,
          },
          protocol: routing.provider || apiResponse.providerType || 'Rubic',
          estimatedTime: isLast ? (estimate?.durationInMinutes || 5) * 60 : 60,
        };
        if (isLast && isDepositTrade) {
          step.details.depositAddress = depositInfo?.depositAddress;
          step.details.depositMemo = depositInfo?.extraFields?.value;
          step.details.depositExchangeId = depositInfo?.exchangeId;
        }
        steps.push(step);
      });
    } else {
      // Fallback: create 2 simple steps for cross-chain, 1 for same-chain
      const isCrossChain = req.fromChainId !== req.toChainId;

      // Source step
      steps.push({
        kind: isCrossChain ? 'bridge' : 'swap',
        chainId: req.fromChainId,
        details: {
          fromToken: tokens.from.address,
          toToken: tokens.to.address,
          fromAmount: tokens.from.amount,
          toAmount: estimate?.destinationTokenAmount || '0',
          provider: apiResponse.providerType || 'Rubic',
          isDeposit: isDepositTrade,
          depositAddress: depositInfo?.depositAddress,
          depositMemo: depositInfo?.extraFields?.value,
          depositExchangeId: depositInfo?.exchangeId,
        },
        protocol: apiResponse.providerType || 'Rubic',
        estimatedTime: (estimate?.durationInMinutes || 5) * 60,
      });

      // Add destination step only for cross-chain
      if (isCrossChain) {
        steps.push({
          kind: 'bridge',
          chainId: req.toChainId,
          details: {
            fromToken: tokens.from.address,
            toToken: tokens.to.address,
            toAmount: estimate?.destinationTokenAmount || '0',
            provider: apiResponse.providerType || 'Rubic',
            isDeposit: isDepositTrade,
          },
          protocol: apiResponse.providerType || 'Rubic',
          estimatedTime: (estimate?.durationInMinutes || 5) * 60,
        });
      }
    }

    // Extract gas fees (not applicable for Solana, but keep for compatibility)
    const gasFees = fees?.gasTokenFees;

    // CRITICAL FIX: Use gasLimit (not totalWeiAmount which is gas cost in wei)
    // totalWeiAmount = gasLimit × gasPrice (can be 168053067831550 wei = 0.168 ETH)
    // gasLimit = actual gas units needed (e.g., 121460)
    // Note: Solana doesn't use gas limit in the same way, but we keep this for EVM compatibility
    const rawGasLimit = gasFees?.gas?.gasLimit;
    const gasLimit = isSolanaSwap
      ? '0'
      : this.validateAndSanitizeGasLimit(rawGasLimit, apiResponse.providerType);

    // Extract detailed fee information
    const gasCostWei = gasFees?.gas?.totalWeiAmount || '0'; // Total cost in wei (gasLimit × gasPrice)
    const gasPrice = gasFees?.gas?.gasPrice || '0'; // Gas price per unit
    const maxFeePerGas = gasFees?.gas?.maxFeePerGas || null; // EIP-1559 max fee per gas
    const maxPriorityFeePerGas = gasFees?.gas?.maxPriorityFeePerGas || null; // EIP-1559 priority fee

    const providerFee =
      gasFees?.provider?.fixedWeiAmount ||
      gasFees?.protocol?.fixedWeiAmount ||
      '0';

    // Extract percentage fees (if available)
    const percentFees = fees?.percentFees || null;
    const percentFeePercent = percentFees?.percent || null;
    const percentFeeToken = percentFees?.token || null;

    // Extract bridge fees (if available)
    const bridgeFee = fees?.bridge || null;

    // Extract estimated amounts (both wei and token formats)
    const destinationWeiAmount = estimate?.destinationWeiAmount || '0';
    const destinationTokenAmount = estimate?.destinationTokenAmount || '0';
    const destinationMinWeiAmount =
      estimate?.destinationMinWeiAmount ||
      estimate?.destinationTokenMinAmount ||
      '0';
    const destinationTokenMinAmount =
      estimate?.destinationTokenMinAmount ||
      estimate?.destinationMinWeiAmount ||
      '0';

    // Extract slippage and price impact
    const slippage = estimate?.slippage || null; // Slippage tolerance used
    const priceImpact = estimate?.priceImpact || null; // Price impact percentage

    // Extract duration
    const durationInMinutes = estimate?.durationInMinutes || 5;
    const etaSeconds = durationInMinutes * 60;

    if (!isSolanaSwap) {
      this.winstonLogger.debug(
        `Rubic gas data: gasLimit=${gasLimit}, gasCostWei=${gasCostWei}, gasPrice=${gasPrice}, providerFee=${providerFee}`,
      );
      if (percentFees) {
        this.winstonLogger.debug(
          `Rubic percentage fees: ${percentFeePercent}% (token: ${percentFeeToken})`,
        );
      }
    }

    return {
      steps,
      totalEstimatedOut: destinationWeiAmount || destinationTokenAmount || '0',
      // Enhanced fees structure with all available details
      fees: {
        gas: gasLimit, // Use gasLimit (actual gas units), or '0' for Solana
        provider: providerFee,
        bridge: bridgeFee || undefined, // Bridge fees if available
        // Add detailed gas cost information
        gasCostWei: gasCostWei, // Total gas cost in wei
        gasPrice: gasPrice, // Gas price per unit
        maxFeePerGas: maxFeePerGas || undefined, // EIP-1559 max fee per gas
        maxPriorityFeePerGas: maxPriorityFeePerGas || undefined, // EIP-1559 priority fee
        // Percentage fees if available
        percentFeePercent: percentFeePercent || undefined,
        percentFeeToken: percentFeeToken || undefined,
      },
      etaSeconds,
      quotedAt: quoteTimestamp,
      expiresAt: quoteExpiresAt,
      timeoutMs: timeoutMs,
      routeId: `rubic-api-${apiResponse.id || Date.now()}`,
      priceImpact: priceImpact?.toString() || undefined,
      // Add minimum output amount (important for slippage protection)
      minOutputAmount:
        destinationMinWeiAmount || destinationTokenMinAmount || undefined,
      confidence: this.calculateAPIRouteConfidence(apiResponse),
      providerRef: {
        apiResponse,
        route: apiResponse,
        id: apiResponse.id,
        rubicId: apiResponse.id,
        isDepositTrade,
        depositInfo,
        timestamp: quoteTimestamp,
        timeoutMs,
        expiresAt: quoteExpiresAt,
        destinationBlockchain: this.mapChainIdToBlockchainName(req.toChainId),
        sellAmountDecimal: req.amount || '0',
        // Add required SwapQuote fields for executors
        sellToken: tokens.from.address,
        buyToken: tokens.to.address,
        // CRITICAL: For native token swaps, use transaction.value as the source of truth
        // Rubic API may return transaction.value that differs slightly from the requested amount
        // (e.g., due to rounding, fee calculations, or aggregator-specific adjustments)
        // The transaction.value is what will actually be sent on-chain, so sellAmount must match it
        // For ERC20 tokens, use the requested amount as transaction.value is typically '0'
        sellAmount: (() => {
          const isNativeTokenSwap =
            !tokens.from.address ||
            tokens.from.address.toLowerCase() ===
              '0x0000000000000000000000000000000000000000' ||
            tokens.from.address.toLowerCase() ===
              '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

          // For native tokens: transaction.value is the actual amount that will be sent
          // For ERC20 tokens: transaction.value is '0' and we use the requested amount
          if (isNativeTokenSwap && transaction?.value) {
            // Use transaction.value as source of truth for native tokens
            // This ensures sellAmount matches the actual transaction value
            return transaction.value;
          }

          // Use requested amount for ERC20 tokens (transaction.value is '0' for ERC20)
          return req.amount || tokens.from.amount || '0';
        })(),
        buyAmount: destinationWeiAmount || destinationTokenAmount || '0',
        minBuyAmount:
          destinationMinWeiAmount || destinationTokenMinAmount || '0',
        // Transaction data - structure differs for Solana vs EVM
        // Solana: { data: "base64_string" } - needs to be deserialized and signed on Solana chain
        // EVM: { to, data, value } - standard contract call
        to: transaction?.to || '', // Empty for Solana
        data: transaction?.data || '0x', // base64 for Solana, hex for EVM
        value: transaction?.value || '0', // Always '0' for Solana, actual amount for native EVM tokens
        gas: gasLimit, // Use gasLimit (actual gas units) for EVM, '0' for Solana
        // Enhanced gas details
        gasLimit: gasLimit,
        gasCostWei: gasCostWei, // Total gas cost in wei
        gasPrice: gasPrice, // Gas price per unit
        maxFeePerGas: maxFeePerGas, // EIP-1559 max fee per gas
        maxPriorityFeePerGas: maxPriorityFeePerGas, // EIP-1559 priority fee
        // Existing fields
        approvalAddress: transaction?.approvalAddress, // Not used for Solana
        allowanceTarget: transaction?.approvalAddress, // map to generic spender field for approvals
        aggregator: 'rubic' as any, // Add aggregator field
        providerType: apiResponse.providerType,
        useRubicContract: apiResponse.useRubicContract,
        statusUrl: apiResponse.statusUrl || apiResponse.historyUrl || undefined,
        // Enhanced estimate details
        destinationWeiAmount: destinationWeiAmount, // Output amount in wei
        destinationTokenAmount: destinationTokenAmount, // Output amount in token decimals
        destinationMinWeiAmount: destinationMinWeiAmount, // Minimum output in wei
        destinationTokenMinAmount: destinationTokenMinAmount, // Minimum output in token decimals
        priceImpact: priceImpact, // Price impact percentage
        slippage: slippage, // Slippage tolerance used
        durationInMinutes: durationInMinutes, // Duration in minutes
        // Fee details
        providerFeeWei: providerFee, // Provider fee in wei
        providerFeeUsd: fees?.gasTokenFees?.provider?.fixedUsdAmount || null, // Provider fee in USD if available
        percentFeePercent: percentFeePercent, // Percentage fee
        percentFeeToken: percentFeeToken, // Token for percentage fee
        bridgeFee: bridgeFee, // Bridge fee if applicable
        // CRITICAL: Add Solana flag for executors to handle differently
        // Solana transactions need special handling:
        // 1. Decode base64 data to VersionedTransaction
        // 2. Add recent blockhash
        // 3. Sign and send to Solana network
        // Reference: https://docs.rubic.finance/rubic-api/rubic-api/integration-example/swaps-from-solana
        isSolanaTransaction: isSolanaSwap,
        sourceBlockchain: sourceBlockchain,
      },
    };
  }

  /**
   * Calculate confidence score for API v2 routes
   * Based on actual Rubic API v2 response structure
   */
  private calculateAPIRouteConfidence(apiResponse: any): number {
    let confidence = 0.75; // Base confidence for Rubic API routes

    const providerType = apiResponse.providerType;
    const estimate = apiResponse.estimate;
    const routing = apiResponse.routing?.[0];

    // Adjust based on provider reputation
    const trustedProviders = ['symbiosis', 'rango', 'across', 'stargate'];
    if (providerType && trustedProviders.includes(providerType.toLowerCase())) {
      confidence += 0.1;
    }

    // Adjust based on estimated time (shorter = higher confidence)
    const durationMinutes = estimate?.durationInMinutes || 0;
    if (durationMinutes > 15) {
      // > 15 minutes
      confidence -= 0.15;
    } else if (durationMinutes < 5) {
      // < 5 minutes
      confidence += 0.05;
    }

    // Adjust based on price impact
    const priceImpact = estimate?.priceImpact || 0;
    if (priceImpact > 5) {
      // > 5%
      confidence -= 0.1;
    } else if (priceImpact < 1) {
      // < 1%
      confidence += 0.05;
    }

    // Boost confidence if no warnings
    if (apiResponse.warnings && apiResponse.warnings.length === 0) {
      confidence += 0.05;
    }

    return Math.max(0.1, Math.min(1.0, confidence));
  }

  /**
   * Execute a cross-chain swap using Rubic SDK
   * Implementation of IMetaAggregator.execute
   *
   * SERVER-SIDE EXECUTION APPROACH:
   * Similar to Li.Fi, Rubic SDK's swap execution requires wallet providers (browser-based)
   * We implement server-side execution by managing the transaction lifecycle manually
   *
   * Process:
   * 1. Retrieve the cached trade from routeId
   * 2. Get transaction data from the trade
   * 3. Sign and broadcast transaction using provided signer
   * 4. Monitor execution status
   *
   * @param routeId - The route ID from the quote (used to retrieve cached trade)
   * @param signerCtx - Signer context containing privateKey/wallet and providerRef with trade data
   * @returns Object containing transaction hashes
   */
  async execute(routeId: string, signerCtx: any): Promise<{ txids: string[] }> {
    await this.ensureInitialized();

    try {
      this.winstonLogger.debug(`Executing Rubic route ${routeId}`);

      // Validate signer context
      if (!signerCtx) {
        throw new Error('Signer context is required for execution');
      }

      // Extract the trade from providerRef
      const rubicTrade = signerCtx.providerRef?.trade;
      if (!rubicTrade) {
        throw new Error(
          'Rubic trade not found. Ensure the route quote providerRef contains trade object.',
        );
      }

      this.winstonLogger.debug('Rubic trade extracted from providerRef');

      // SERVER-SIDE LIMITATION:
      // Similar to Li.Fi, we need a wallet/signer to execute the trade
      // The SDK's swap() method requires a Web3Provider (browser-based)

      if (signerCtx.sign && typeof signerCtx.sign === 'function') {
        // Option 1: Signing callback provided
        this.winstonLogger.debug('Using provided signing function');

        // Get transaction config from trade
        // This would require accessing the trade's transaction data
        // which varies by provider

        throw new Error(
          'Rubic trade execution with signing function not yet implemented. ' +
            'Transaction data extraction from Rubic trade objects requires provider-specific handling.',
        );
      } else {
        // Option 2: Return transaction data for external signing
        this.winstonLogger.warn(
          'No signing method provided. Rubic execution requires external wallet integration.',
        );

        throw new Error(
          JSON.stringify({
            code: 'SIGNING_REQUIRED',
            message: 'Transaction requires external signing with wallet',
            tradeInfo: {
              routeId,
              from: rubicTrade.from,
              to: rubicTrade.to,
              type: rubicTrade.type,
            },
            instructions: [
              '1. Use Rubic SDK client-side with Web3Provider',
              '2. Call trade.swap() method with connected wallet',
              '3. Monitor transaction status via bridge provider',
            ],
          }),
        );
      }
    } catch (error) {
      this.winstonLogger.error(
        `Failed to execute Rubic route: ${error.message}`,
        error.stack,
      );

      // If it's our structured error, re-throw it
      if (error.message?.startsWith('{')) {
        throw error;
      }

      throw new Error(`Rubic execution failed: ${error.message}`);
    }
  }

  /**
   * Provider health check
   */
  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();

    try {
      // Check if SDK is initialized
      if (!this.sdk && this.initializationPromise) {
        await this.initializationPromise;
      }

      if (!this.sdk) {
        return {
          name: this.getProviderName(),
          status: 'unhealthy',
          lastCheck: new Date(),
          errorRate: 1,
        };
      }

      // Rubic SDK doesn't have a dedicated health endpoint
      // We can verify it's working by checking if we can access managers
      const hasOnChainManager = !!this.sdk.onChainManager;
      const hasCrossChainManager = !!this.sdk.crossChainManager;

      if (!hasOnChainManager || !hasCrossChainManager) {
        return {
          name: this.getProviderName(),
          status: 'degraded',
          lastCheck: new Date(),
          errorRate: 0.5,
          latency: Date.now() - startTime,
        };
      }

      return {
        name: this.getProviderName(),
        status: 'healthy',
        latency: Date.now() - startTime,
        lastCheck: new Date(),
        errorRate: 0,
      };
    } catch (error) {
      return {
        name: this.getProviderName(),
        status: 'unhealthy',
        lastCheck: new Date(),
        errorRate: 1,
      };
    }
  }

  /**
   * Get provider configuration
   */
  getConfig(): ProviderConfig {
    return {
      name: this.getProviderName(),
      baseUrl: 'https://api.rubic.exchange', // Rubic uses SDK, not direct API
      enabled: true,
      rateLimit: {
        requests: 100,
        perSeconds: 60,
      },
      timeout: 30000, // 30 seconds for complex calculations
      retries: 2,
    };
  }

  /**
   * Convert Rubic WrappedCrossChainTrade to RouteQuote
   */
  private convertToRouteQuote(wrapped: any, request: any): RouteQuote {
    const trade = wrapped.trade as CrossChainTrade;

    // Extract steps from the trade
    const steps: Step[] = this.extractSteps(trade, request);

    // Calculate fees
    const fees = {
      gas: this.extractGasFee(trade),
      provider: this.extractProviderFee(trade),
      bridge: this.extractBridgeFee(trade),
    };

    // Estimate time based on trade type
    const etaSeconds = this.estimateExecutionTime(wrapped.tradeType);

    return {
      steps,
      totalEstimatedOut: trade.to.tokenAmount.toFixed(),
      fees,
      etaSeconds,
      routeId: `rubic_${wrapped.tradeType}_${Date.now()}`,
      confidence: this.calculateConfidence(trade, wrapped),
      providerRef: {
        rubicTrade: trade,
        tradeType: wrapped.tradeType,
        provider: 'Rubic',
        // Best-effort approval spender mapping for SDK trades
        allowanceTarget:
          (trade as any)?.approveAddress ||
          (trade as any)?.from?.approveTarget ||
          undefined,
      },
    };
  }

  /**
   * Extract steps from Rubic trade
   */
  private extractSteps(trade: CrossChainTrade, request: any): Step[] {
    const steps: Step[] = [];

    // Source chain swap step
    steps.push({
      kind: 'swap',
      chainId:
        typeof request.fromChainId === 'number' ? request.fromChainId : 0,
      protocol: trade.type,
      details: {
        fromToken: trade.from.address,
        toToken: trade.to.address,
        fromAmount: trade.from.tokenAmount.toFixed(),
      },
      estimatedTime: 60, // 1 minute for source swap
    });

    // Bridge step (if cross-chain)
    if (request.fromChainId !== request.toChainId) {
      steps.push({
        kind: 'bridge',
        chainId:
          typeof request.fromChainId === 'number' ? request.fromChainId : 0,
        protocol: trade.type,
        details: {
          bridge: trade.type,
          fromChain: request.fromChainId,
          toChain: request.toChainId,
        },
        estimatedTime: this.estimateExecutionTime(trade.type) - 120, // Total minus swap times
      });
    }

    // Destination chain swap step
    steps.push({
      kind: 'swap',
      chainId: typeof request.toChainId === 'number' ? request.toChainId : 0,
      protocol: trade.type,
      details: {
        toAmount: trade.to.tokenAmount.toFixed(),
      },
      estimatedTime: 60, // 1 minute for destination swap
    });

    return steps;
  }

  /**
   * Extract gas fee from trade
   */
  private extractGasFee(trade: CrossChainTrade): string {
    try {
      // Rubic includes gas estimates in feeInfo
      const gasPrice = trade.feeInfo?.rubicProxy?.fixedFee?.amount;
      return gasPrice?.toFixed() || '0';
    } catch {
      return '0';
    }
  }

  /**
   * Extract provider fee from trade
   */
  private extractProviderFee(trade: CrossChainTrade): string {
    try {
      const providerFee = trade.feeInfo?.provider?.cryptoFee?.amount;
      return providerFee?.toFixed() || '0';
    } catch {
      return '0';
    }
  }

  /**
   * Extract bridge fee from trade
   */
  private extractBridgeFee(trade: CrossChainTrade): string {
    try {
      // Bridge fees are usually included in provider fees for Rubic
      return '0';
    } catch {
      return '0';
    }
  }

  /**
   * Estimate execution time based on trade type
   */
  private estimateExecutionTime(tradeType: string): number {
    // Rough estimates based on typical bridge times
    const timeEstimates: Record<string, number> = {
      // Fast bridges
      ACROSS: 180, // 3 minutes
      STARGATE: 300, // 5 minutes
      CELER_BRIDGE: 300, // 5 minutes

      // Medium bridges
      SYMBIOSIS: 600, // 10 minutes
      LAYERZERO: 600, // 10 minutes
      DEBRIDGE: 900, // 15 minutes

      // Slower bridges
      MULTICHAIN: 1200, // 20 minutes
      ARBITRUM_BRIDGE: 1800, // 30 minutes

      // Default
      DEFAULT: 600, // 10 minutes
    };

    return timeEstimates[tradeType] || timeEstimates.DEFAULT;
  }

  /**
   * Calculate confidence score for the route
   */
  private calculateConfidence(trade: CrossChainTrade, wrapped: any): number {
    let confidence = 0.85; // Base confidence for Rubic

    try {
      // Boost confidence if no errors
      if (!wrapped.error) {
        confidence += 0.05;
      }

      // Note: price impact may not be available on all Rubic trades
      // Skipping price impact checks to avoid errors

      // Boost confidence for well-known bridges
      const trustedBridges = [
        'STARGATE',
        'ACROSS',
        'CELER_BRIDGE',
        'LAYERZERO',
      ];
      if (trustedBridges.includes(trade.type)) {
        confidence += 0.05;
      }
    } catch (error) {
      this.winstonLogger.debug(
        `Error calculating confidence: ${error.message}`,
      );
    }

    return Math.max(0.1, Math.min(1.0, confidence));
  }

  /**
   * Map chain ID to Rubic BLOCKCHAIN_NAME
   */
  /**
   * Map standard chain ID to Rubic API v2 chain ID
   * Handles both numeric EVM chain IDs and string-based native L1 identifiers
   */
  private mapChainIdToRubicId(chainId: number | string): number | string {
    const rubicChainId = this.chainIdToRubicChainId[chainId];
    if (rubicChainId === undefined) {
      throw new Error(`Unsupported chain ID for Rubic: ${chainId}`);
    }
    return rubicChainId;
  }

  /**
   * Map chain ID to Rubic SDK BLOCKCHAIN_NAME (for SDK-based swaps)
   * Only works for EVM chains that the SDK supports
   */
  private mapChainIdToBlockchain(chainId: number | string): string {
    // Handle string chainIds (native L1 chains)
    if (typeof chainId === 'string') {
      // For native L1 chains, we should use Rubic API v2 instead of SDK
      // The SDK doesn't support Bitcoin, Dogecoin, etc.
      throw new Error(
        `Rubic SDK does not support native L1 chain: ${chainId}. ` +
          `Use Rubic API v2 directly for Bitcoin, Solana, etc.`,
      );
    }

    const blockchain = this.chainIdToBlockchain[chainId];
    if (!blockchain) {
      throw new Error(`Unsupported EVM chain ID for Rubic SDK: ${chainId}`);
    }

    return blockchain;
  }

  /**
   * Get supported chain pairs
   * Implementation of IMetaAggregator.getSupportedChains
   * Returns all chains that Rubic supports for cross-chain swaps
   */
  getSupportedChains(): { from: number[]; to: number[] } {
    const chains = Object.keys(this.chainIdToBlockchain).map(Number);
    return {
      from: chains,
      to: chains,
    };
  }

  /**
   * Check execution status of a cross-chain transaction
   * Implementation of IMetaAggregator.status
   *
   * Uses Rubic's transaction tracking to monitor cross-chain swap progress
   *
   * @param txHash - Source chain transaction hash
   * @returns Execution status (PENDING, SUCCESS, FAILED)
   */
  async status(txHash: string): Promise<ExecutionStatus> {
    try {
      this.winstonLogger.debug(
        `Checking Rubic transaction status for ${txHash}`,
      );

      // Placeholder implementation: returns PENDING by default.
      // Extend: query provider-specific status endpoints and map to ExecutionStatus.
      // Example scaffolding (disabled until exact API verified):
      // const resp = await this.httpService.get(`https://api-v2.rubic.exchange/api/tx/status?txHash=${txHash}`, { timeout: 15000 });
      // const status = this.mapRubicStatus(resp?.status);
      // return status;

      return 'PENDING';
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get Rubic status for ${txHash}: ${error.message}`,
        error.stack,
      );
      // Return PENDING on error as the transaction might still be processing
      return 'PENDING';
    }
  }

  /**
   * Optional richer status API: returns destination tx hash and status details if available.
   * Consumers (executors/controllers) can call this to enrich status snapshots.
   */
  /**
   * Get bridge status from Rubic API v2
   * Reference: https://docs.rubic.finance/rubic-api/rubic-api/get-cross-chain-status
   *
   * @param txHash - Source transaction hash
   * @param providerRef - Optional provider reference for additional context
   * @returns Bridge status including destination transaction hash and chain info
   */
  async getBridgeStatus(
    txHash: string,
    providerRef?: any,
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
    const startTime = Date.now();

    try {
      this.winstonLogger.debug(
        `Fetching Rubic bridge status for txHash: ${txHash}`,
      );

      // Prefer the extended status endpoint if possible (provides destTxHash reliably)
      // Try to extract rubicId from providerRef if available
      let rubicId: string | undefined;
      try {
        const pr: any = providerRef || {};
        rubicId = pr.id || pr.rubicId;
        if (!rubicId && typeof pr.routeId === 'string') {
          // Attempt to parse from routeId pattern e.g. "rubic-api-<UUID>"
          // Extract only the base UUID, excluding any _adjusted_timestamp suffixes
          // Pattern: rubic-api-<UUID> where UUID is 8-4-4-4-12 hex digits with hyphens
          // Example: rubic-api-8e61a8e4-a2a5-4733-b61b-29a881efd2cd_adjusted_1764919328894
          // Should extract: 8e61a8e4-a2a5-4733-b61b-29a881efd2cd
          const match = pr.routeId.match(
            /rubic[-_]api[-_]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
          );
          if (match && match[1]) {
            rubicId = match[1];
            this.winstonLogger.debug(
              `Extracted Rubic ID from routeId: ${rubicId} | routeId: ${pr.routeId} | extractedId: ${rubicId}`,
            );
          }
        }

        // Log the Rubic ID (or lack thereof) for debugging
        this.winstonLogger.debug(
          `Rubic bridge status check | txHash: ${txHash} | rubicId: ${rubicId || 'NOT_FOUND'} | ` +
            `hasProviderRef: ${!!providerRef} | providerRefType: ${typeof providerRef} | routeId: ${pr?.routeId}`,
        );
      } catch (e) {
        this.winstonLogger.warn(`Failed to extract Rubic ID: ${e.message}`);
      }

      let data: any;
      let endpointUsed = '';
      try {
        const query = rubicId
          ? `/api/info/statusExtended?srcTxHash=${txHash}&rubicId=${encodeURIComponent(rubicId)}`
          : `/api/info/statusExtended?srcTxHash=${txHash}`;
        endpointUsed = `${this.RUBIC_API_BASE_URL}${query}`;

        this.winstonLogger.log(
          `🔍 Checking Rubic bridge status | txHash: ${txHash} | rubicId: ${rubicId || 'N/A'} | endpoint: statusExtended`,
        );

        data = await this.rubicApiGet(query, this.STATUS_API_TIMEOUT);

        // Log complete raw response for debugging
        this.winstonLogger.log(
          `📦 Rubic Status API Response | txHash: ${txHash} | ` +
            `response: ${JSON.stringify(data, null, 2)}`,
        );
      } catch (e) {
        // Fallback to legacy status endpoint
        this.winstonLogger.warn(
          `statusExtended failed, falling back to status: ${e.message}`,
        );

        const fallbackQuery = `/api/info/status?srcTxHash=${txHash}`;
        endpointUsed = `${this.RUBIC_API_BASE_URL}${fallbackQuery}`;

        data = await this.rubicApiGet(fallbackQuery, this.STATUS_API_TIMEOUT);

        // Log fallback response
        this.winstonLogger.log(
          `📦 Rubic Status API Response (fallback) | txHash: ${txHash} | ` +
            `response: ${JSON.stringify(data, null, 2)}`,
        );
      }

      // Map Rubic status to our standard format
      let mappedStatus:
        | 'initiated'
        | 'pending'
        | 'in_progress'
        | 'completed'
        | 'failed'
        | 'reverted';
      const rubicStatus = (data.status || '').toUpperCase();

      // Log status mapping
      this.winstonLogger.debug(
        `🔄 Mapping Rubic status | raw: "${data.status}" | uppercase: "${rubicStatus}" | txHash: ${txHash}`,
      );

      switch (rubicStatus) {
        case 'COMPLETED':
        case 'SUCCESS':
          mappedStatus = 'completed';
          this.winstonLogger.log(
            `✅ Bridge completed! | txHash: ${txHash} | status: ${data.status}`,
          );
          break;
        case 'IN_PROGRESS':
        case 'PROCESSING':
          mappedStatus = 'in_progress';
          break;
        case 'PENDING':
        case 'WAITING':
          mappedStatus = 'pending';
          break;
        case 'FAILED':
        case 'ERROR':
          mappedStatus = 'failed';
          this.winstonLogger.error(
            `❌ Bridge failed! | txHash: ${txHash} | status: ${data.status} | response: ${JSON.stringify(data)}`,
          );
          break;
        case 'REVERTED':
        case 'REVERT':
          mappedStatus = 'reverted';
          this.winstonLogger.log(
            `🔄 Swap reverted - funds returned to sender | txHash: ${txHash} | status: ${data.status}`,
          );
          break;
        default:
          mappedStatus = 'pending';
          this.winstonLogger.warn(
            `⚠️ UNKNOWN Rubic status detected! | txHash: ${txHash} | ` +
              `rawStatus: "${data.status}" | uppercaseStatus: "${rubicStatus}" | ` +
              `fullResponse: ${JSON.stringify(data)} | ` +
              `endpoint: ${endpointUsed}`,
          );
      }

      // Extract destination transaction hash and chain info
      const destTxHash =
        data.destinationTxHash ||
        data.dstTxHash ||
        data.destTxHash ||
        data?.txes?.destinationTxHash;
      const destChainName =
        data.bridgeChain || data.destChain || data.destinationChain;
      const destChainId =
        data.bridgeChainId || data.destChainId || data.destinationChainId;

      // Log extracted fields for debugging
      this.winstonLogger.debug(
        `🔍 Extracted fields | txHash: ${txHash} | ` +
          `destTxHash: ${destTxHash || 'N/A'} | ` +
          `destChain: ${destChainName || destChainId || 'N/A'} | ` +
          `availableFields: ${JSON.stringify({
            destinationTxHash: data.destinationTxHash,
            dstTxHash: data.dstTxHash,
            destTxHash: data.destTxHash,
            'txes.destinationTxHash': data?.txes?.destinationTxHash,
            bridgeChain: data.bridgeChain,
            destChain: data.destChain,
            destinationChain: data.destinationChain,
            bridgeChainId: data.bridgeChainId,
            destChainId: data.destChainId,
            destinationChainId: data.destinationChainId,
          })}`,
      );

      // Calculate ETA in milliseconds
      let etaMs: number | undefined;
      if (data.estimatedTime && typeof data.estimatedTime === 'number') {
        etaMs = data.estimatedTime * 1000; // Convert seconds to milliseconds
      } else if (mappedStatus === 'pending' || mappedStatus === 'in_progress') {
        etaMs = 30 * 60 * 1000; // Default 30 minutes for pending/in-progress
      }

      const result = {
        status: mappedStatus,
        destTxHash,
        destChainId,
        destChainName,
        etaMs,
        toAmount: data.toAmount || null,
        toAmountWei: data.toAmountWei || null,
        statusUrl: rubicId
          ? `${this.RUBIC_API_BASE_URL}/api/info/statusExtended?srcTxHash=${txHash}&rubicId=${encodeURIComponent(rubicId)}`
          : `${this.RUBIC_API_BASE_URL}/api/info/statusExtended?srcTxHash=${txHash}`,
      };

      // Log final result being returned
      this.winstonLogger.log(
        `📤 Rubic bridge status result | txHash: ${txHash} | ` +
          `mappedStatus: ${mappedStatus} | ` +
          `destTxHash: ${destTxHash || 'N/A'} | ` +
          `destChain: ${destChainName || destChainId || 'N/A'} | ` +
          `ETA: ${etaMs ? Math.round(etaMs / 60000) + ' min' : 'N/A'} | ` +
          `result: ${JSON.stringify(result)}`,
      );

      this.winstonLogger.debug(
        `Rubic bridge status fetched: ${mappedStatus} | ` +
          `destTxHash: ${destTxHash || 'pending'} | ` +
          `destChain: ${destChainName || destChainId || 'unknown'} | ` +
          `ETA: ${etaMs ? Math.round(etaMs / 60000) + ' min' : 'N/A'}`,
      );

      // Audit log bridge status check using helper
      const duration = Date.now() - startTime;
      this.logAuditEvent('AGGREGATOR_BRIDGE_STATUS_CHECK', {
        txHash,
        status: result.status,
        destTxHash: result.destTxHash,
        destChainId: result.destChainId,
        destChainName: result.destChainName,
        etaMs: result.etaMs,
        duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Log error but return pending status instead of throwing
      // This allows execution to continue even if status check fails
      this.winstonLogger.warn(
        `Failed to fetch Rubic bridge status for txHash: ${txHash} | ` +
          `Error: ${error.message} | Duration: ${duration}ms`,
      );

      this.winstonLogger.audit('AGGREGATOR_BRIDGE_STATUS_FAILED', {
        aggregator: 'Rubic',
        txHash,
        error: error.message,
        errorType: this.categorizeError(error),
        duration,
        timestamp: new Date().toISOString(),
      });

      // Return pending status on error - don't break the flow
      return {
        status: 'pending' as const,
        destTxHash: undefined,
        destChainId: undefined,
        destChainName: undefined,
        etaMs: 30 * 60 * 1000, // Default 30 minutes
        statusUrl: `https://api-v2.rubic.exchange/api/info/status?srcTxHash=${txHash}`,
      };
    }
  }

  /**
   * Categorize error for analytics and monitoring
   */
  private categorizeError(error: any): string {
    const errorMsg = error?.message?.toLowerCase() || '';
    const statusCode = error?.response?.status || error?.statusCode;

    if (statusCode === 429 || errorMsg.includes('rate limit')) {
      return 'rate_limit';
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return 'client_error';
    }
    if (statusCode && statusCode >= 500) {
      return 'server_error';
    }
    if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
      return 'timeout';
    }
    if (errorMsg.includes('network') || errorMsg.includes('econnrefused')) {
      return 'network_error';
    }
    if (
      errorMsg.includes('insufficient liquidity') ||
      errorMsg.includes('no routes')
    ) {
      return 'insufficient_liquidity';
    }
    if (
      errorMsg.includes('unsupported chain') ||
      errorMsg.includes('unsupported')
    ) {
      return 'unsupported_chain';
    }
    if (
      errorMsg.includes('invalid token') ||
      errorMsg.includes('token not found')
    ) {
      return 'invalid_token';
    }
    if (errorMsg.includes('bridge') || errorMsg.includes('cross-chain')) {
      return 'bridge_error';
    }

    return 'unknown_error';
  }
}
