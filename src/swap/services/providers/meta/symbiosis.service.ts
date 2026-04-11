import { Injectable, Optional, Inject, OnModuleInit } from '@nestjs/common';
import {
  IMetaAggregator,
  IProvider,
  RouteRequest,
  RouteQuote,
  ExecutionStatus,
  ProviderHealth,
  ProviderConfig,
  Step,
} from '@swap/models/ports';
import type { IAggregatorRegistry } from '@swap/services/core/aggregation/aggregator-registry.interface';
import { AggregatorManagerService } from '@swap/services/core/aggregation/aggregator-manager.service';
import { CustomHttpService } from '@shared/services/http.service';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { AmountNormalizationUtils } from '@shared/utils/amount-normalization.utils';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Thread-safe rate limiter for Symbiosis API
 * Enforces 1 request per second (1 RPS) for /v2/swap endpoint
 * 
 * PRODUCTION FIX: Added mutex-like locking to prevent race conditions
 */
class SimpleRateLimiter {
  private lastCallTime = 0;
  private readonly minInterval = 1000; // 1 second
  private pendingPromise: Promise<void> | null = null;

  async acquire(): Promise<void> {
    // Wait for any pending acquisition to complete (prevents race conditions)
    while (this.pendingPromise) {
      await this.pendingPromise;
    }

    // Create new promise for this acquisition
    this.pendingPromise = this.performAcquisition();
    
    try {
      await this.pendingPromise;
    } finally {
      this.pendingPromise = null;
    }
  }

  private async performAcquisition(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;

    if (timeSinceLastCall < this.minInterval) {
      const delay = this.minInterval - timeSinceLastCall;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.lastCallTime = Date.now();
  }
}

/**
 * Symbiosis Meta Aggregator Service
 *
 * Specialized cross-chain bridge aggregator supporting 53+ chains including Tron.
 * Solves the limitation where current aggregators (0x, Odos, Rubic) cannot efficiently
 * provide quotes for Tron-based assets like TRX-USDT(TRX).
 *
 * Key Features:
 * - Cross-chain swaps via Symbiosis bridge infrastructure
 * - Native Tron support (chainId 728126428 in Symbiosis API)
 * - Bidirectional chain ID mapping (Internal 195 ↔ Symbiosis 728126428)
 * - Rate limiting compliance (1 RPS for /v2/swap)
 * - Self-registration with AggregatorManager
 *
 * API Documentation: https://docs.symbiosis.finance
 * Swagger Spec: https://api.symbiosis.finance/crosschain/v2/swagger
 *
 * @implements {IMetaAggregator} Cross-chain routing interface
 * @implements {IProvider} Provider health and configuration interface
 * @implements {OnModuleInit} NestJS lifecycle hook for self-registration
 */
@Injectable()
export class SymbiosisService
  implements IMetaAggregator, IProvider, OnModuleInit
{
  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  private readonly API_BASE_URL = 'https://api.symbiosis.finance/crosschain';
  private readonly PARTNER_ID: string;
  private readonly API_TIMEOUT = 30000; // 30 seconds
  private readonly QUOTE_TIMEOUT = 15000; // 15 seconds for quotes
  private readonly rateLimiter = new SimpleRateLimiter();

  /**
   * Chain ID Mapping: Internal → Symbiosis
   *
   * CRITICAL: Tron uses different chain IDs across systems:
   * - Internal system: 195 (numeric) or 'tron-mainnet' (string)
   * - Rubic API: 195 (numeric)
   * - Symbiosis API: 728126428 (non-standard)
   *
   * This mapping ensures correct translation for Symbiosis API calls.
   */
  private readonly chainIdToSymbiosis: Record<number | string, number> = {
    // ========================================
    // EVM Chains (Standard - 1:1 Mapping)
    // ========================================
    1: 1, // Ethereum
    56: 56, // BSC (Binance Smart Chain)
    137: 137, // Polygon
    42161: 42161, // Arbitrum One
    10: 10, // Optimism
    43114: 43114, // Avalanche C-Chain
    8453: 8453, // Base
    250: 250, // Fantom
    42220: 42220, // Celo
    100: 100, // Gnosis Chain
    324: 324, // zkSync Era
    1101: 1101, // Polygon zkEVM
    59144: 59144, // Linea
    5000: 5000, // Mantle
    534352: 534352, // Scroll

    // ========================================
    // Non-Standard Mappings (CRITICAL)
    // ========================================

    // Tron Mappings (HIGHEST PRIORITY - Primary use case)
    195: 728126428, // Tron: Internal numeric ID → Symbiosis ID
    tron: 728126428, // Tron: Alternative identifier
    'tron-mainnet': 728126428, // Tron: Canonical string ID

    // Bitcoin Mappings (if needed in future)
    'bitcoin-mainnet': 3652501241, // Bitcoin canonical
    bitcoin: 3652501241, // Bitcoin alternative
    5555: 3652501241, // Bitcoin: Rubic's numeric ID

    // TON Mappings (if needed in future)
    'ton-mainnet': 85918, // TON canonical
    ton: 85918, // TON alternative
  };

  /**
   * Reverse Mapping: Symbiosis → Internal
   *
   * Used for status tracking and response parsing where Symbiosis
   * returns their chain IDs and we need to map back to internal format.
   */
  private readonly symbiosisToChainId: Record<number, number | string> = {
    // Non-standard chain ID reversals
    728126428: 195, // Tron → Internal numeric
    3652501241: 5555, // Bitcoin → Rubic's numeric ID
    85918: 'ton-mainnet', // TON → Internal string

    // Standard EVM chains use 1:1 mapping (omitted for brevity)
    // They pass through unchanged: 1→1, 56→56, 137→137, etc.
  };

  // ============================================================================
  // DEPENDENCY INJECTION
  // ============================================================================

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
    this.winstonLogger.setContext(SymbiosisService.name);

    // Load Partner ID from environment (optional - API works without it)
    this.PARTNER_ID = this.envConfig.symbiosisPartnerId || '';

    if (!this.PARTNER_ID) {
      this.winstonLogger.warn(
        'SYMBIOSIS_PARTNER_ID not configured - API will work but tracking may be limited',
      );
    }
  }

  // ============================================================================
  // SELF-REGISTRATION (NestJS Lifecycle)
  // ============================================================================

  /**
   * Self-register with AggregatorManagerService on module initialization
   * Follows the provider self-registration pattern used by RubicService
   */
  async onModuleInit() {
    // Check if service is enabled via feature flag
    const isEnabled = this.envConfig.symbiosisEnabled;

    if (!isEnabled) {
      this.winstonLogger.warn(
        '⚠️ Symbiosis provider disabled via SYMBIOSIS_ENABLED feature flag',
      );
      return;
    }

    if (this.registry) {
      this.registry.registerMetaAggregator(this);
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
  // IMetaAggregator IMPLEMENTATION
  // ============================================================================

  /**
   * Get cross-chain routes for a swap request
   *
   * @param req - Route request with source/destination chains and tokens
   * @returns Array of route quotes with steps, fees, and estimated output
   *
   * Flow:
   * 1. Map internal chain IDs to Symbiosis format (195 → 728126428)
   * 2. Call Symbiosis API: POST /v2/quote
   * 3. Parse response and convert to RouteQuote format
   * 4. Cache route data in providerRef for execution
   */
  async getRoutes(req: RouteRequest): Promise<RouteQuote[]> {
    const startTime = Date.now();

    try {
      this.winstonLogger.debug(
        `Fetching Symbiosis routes: ${req.fromChainId} → ${req.toChainId}`,
        {
          fromToken: req.fromToken,
          toToken: req.toToken,
          amount: req.amount,
        },
      );

      // STEP 1: Map chain IDs to Symbiosis format
      const fromChainId = this.mapToSymbiosis(req.fromChainId);
      const toChainId = this.mapToSymbiosis(req.toChainId);

      // STEP 2: Get token decimals
      const fromDecimals = await this.getTokenDecimals(
        req.fromChainId,
        req.fromToken,
      );
      const toDecimals = await this.getTokenDecimals(
        req.toChainId,
        req.toToken,
      );

      // STEP 3: Build Symbiosis API request (must include symbol field)
      const quoteRequest = {
        tokenAmountIn: {
          chainId: fromChainId,
          address: this.normalizeTokenAddress(req.fromToken),
          symbol: this.getTokenSymbol(req.fromToken, req.fromChainId),
          amount: req.amount,
          decimals: fromDecimals,
        },
        tokenOut: {
          chainId: toChainId,
          address: this.normalizeTokenAddress(req.toToken),
          symbol: this.getTokenSymbol(req.toToken, req.toChainId),
          decimals: toDecimals,
        },
        from: req.userAddress || '',
        to: req.recipient || req.userAddress || '',
        slippage: this.convertSlippage(req.slippageBps),
      };

      // SECURITY FIX: Sanitize request logging - don't log potentially sensitive user data
      this.winstonLogger.debug('📤 Symbiosis API request', {
        url: `${this.API_BASE_URL}/v2/quote`,
        method: 'POST',
        fromChain: req.fromChainId,
        toChain: req.toChainId,
        fromToken: req.fromToken?.substring(0, 10) + '...', // Truncate addresses
        toToken: req.toToken?.substring(0, 10) + '...',
        amountLength: req.amount?.length, // Log amount length not value
      });

      // STEP 4: Call Symbiosis API with retry logic
      let response: any;
      let lastError: any;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          response = await this.httpService.post(
            `${this.API_BASE_URL}/v2/quote`,
            quoteRequest,
            {
              headers: this.buildHeaders(),
              timeout: this.QUOTE_TIMEOUT,
            },
          );
          break; // Success, exit retry loop
        } catch (error) {
          lastError = error;
          
          // Check if error is retryable (network errors, 5xx, 429)
          const isRetryable = this.isRetryableError(error);
          
          if (attempt < maxRetries && isRetryable) {
            const backoffDelay = attempt * 1000; // 1s, 2s, 3s
            this.winstonLogger.warn(
              `Symbiosis API call failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffDelay}ms`,
              { error: error.message, status: error.response?.status },
            );
            await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          } else {
            throw error; // Non-retryable or max retries reached
          }
        }
      }

      // VALIDATION FIX: Validate response structure before processing
      if (!response || typeof response !== 'object') {
        throw new Error('Invalid response from Symbiosis API: response is null or not an object');
      }

      // Validate response data structure
      this.validateSymbiosisResponse(response);

      // SECURITY FIX: Sanitized response logging
      this.winstonLogger.debug('✅ Symbiosis API response received', {
        hasData: !!response,
        responseKeys: response ? Object.keys(response).slice(0, 10) : [], // Limit keys
        kind: response.kind,
        hasTokenAmountOut: !!response.tokenAmountOut,
        hasTx: !!response.tx,
      });

      // STEP 5: Convert to RouteQuote format
      const routes = this.convertToRouteQuote(response, req);

      const duration = Date.now() - startTime;
      this.winstonLogger.debug(
        `✅ Symbiosis routes fetched successfully (${duration}ms)`,
        {
          routeCount: routes.length,
          estimatedOut: routes[0]?.totalEstimatedOut,
        },
      );

      return routes;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Extract detailed error information from API response
      const errorDetails: any = {
        message: error.message,
        request: req,
      };

      // Capture API response details if available
      if (error.response) {
        errorDetails.status = error.response.status;
        errorDetails.statusText = error.response.statusText;
        errorDetails.data = error.response.data;
      }

      this.winstonLogger.error(
        `❌ Symbiosis getRoutes failed (${duration}ms)`,
        errorDetails,
      );

      throw new Error(`Symbiosis route fetch failed: ${error.message}`);
    }
  }

  /**
   * Execute a cached cross-chain route
   *
   * @param routeId - Route identifier (not used, cached in providerRef)
   * @param signerCtx - Signer context with wallet and providerRef
   * @returns Transaction hash array
   *
   * Flow:
   * 1. Retrieve cached route data from signerCtx.providerRef
   * 2. Call Symbiosis API: POST /v2/swap (with rate limiting)
   * 3. Execute transaction on source chain
   * 4. Return transaction hash
   */
  async execute(routeId: string, signerCtx: any): Promise<{ txids: string[] }> {
    const startTime = Date.now();

    try {
      this.winstonLogger.debug(`Executing Symbiosis route: ${routeId}`);

      // STEP 1: Retrieve cached route data
      const cachedRoute = signerCtx.providerRef?.symbiosisData;
      if (!cachedRoute) {
        throw new Error(
          'Symbiosis route data not found in providerRef. Please re-request routes.',
        );
      }

      // STEP 2: Call /v2/swap with rate limiting (1 RPS)
      await this.rateLimiter.acquire();

      const swapResponse = (await this.httpService.post(
        `${this.API_BASE_URL}/v2/swap`,
        cachedRoute,
        {
          headers: this.buildHeaders(),
          timeout: this.API_TIMEOUT,
        },
      )) as { data: any };

      if (!swapResponse.data?.tx) {
        throw new Error('Symbiosis API did not return transaction data');
      }

      // STEP 3: Execute transaction (delegate to executor)
      // Note: Actual transaction execution is handled by MetaSwapExecutor
      // We return the transaction data for the executor to sign and send
      const txData = swapResponse.data.tx;

      // Extract function selector information if provided separately by Symbiosis
      const enhancedTxData = {
        ...txData,
        // Pass function selector separately if Symbiosis provides it
        functionSelector:
          txData.functionSelector || swapResponse.data.functionSelector,
        // Also preserve any method information
        method: txData.method || swapResponse.data.method,
      };

      this.winstonLogger.debug('✅ Symbiosis swap transaction prepared', {
        to: txData.to,
        value: txData.value,
        dataLength: txData.data?.length,
        // Log the complete transaction data structure for analysis
        txDataKeys: Object.keys(txData),
        swapDataKeys: Object.keys(swapResponse.data),
        hasData: !!txData.data,
        hasFunctionSelector: !!txData.functionSelector,
        hasSwapFunctionSelector: !!swapResponse.data.functionSelector,
        functionSelector:
          txData.functionSelector || swapResponse.data.functionSelector,
        method: txData.method || swapResponse.data.method,
        // Log first 10 chars of data to see if it contains function selector
        dataPrefix: txData.data?.slice(0, 10),
        dataIsPureParameters:
          !txData.functionSelector && !swapResponse.data.functionSelector,
      });

      // Return enhanced transaction data with function selector info
      const duration = Date.now() - startTime;
      this.winstonLogger.debug(
        `✅ Symbiosis execute completed (${duration}ms)`,
      );

      return { txids: [enhancedTxData.hash || 'pending'] };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.winstonLogger.error(`❌ Symbiosis execute failed (${duration}ms)`, {
        error: error.message,
        routeId,
        stack: error.stack,
      });

      throw new Error(`Symbiosis execution failed: ${error.message}`);
    }
  }

  /**
   * Check execution status of a cross-chain transaction
   *
   * @param txHash - Source chain transaction hash
   * @param sourceChainId - Optional source chain ID (recommended to avoid detection errors)
   * @returns Execution status (pending, completed, failed)
   *
   * Flow:
   * 1. Determine source chain from parameter or transaction hash
   * 2. Map to Symbiosis chain ID
   * 3. Call Symbiosis API: GET /v2/tx/{chainId}/{txHash}
   * 4. Parse and return execution status
   *
   * Note: sourceChainId parameter is highly recommended for accurate status checks,
   * especially for Tron (195) and other non-standard chains.
   */
  async status(
    txHash: string,
    sourceChainId?: number | string,
  ): Promise<ExecutionStatus> {
    try {
      this.winstonLogger.debug(`Checking Symbiosis status for tx: ${txHash}`, {
        providedChainId: sourceChainId,
      });

      // STEP 1: Determine source chain
      // Prefer provided chainId over detection to avoid errors
      let chainId: number | string;
      if (sourceChainId !== undefined) {
        chainId = sourceChainId;
        this.winstonLogger.debug(
          `Using provided source chain ID: ${chainId}`,
        );
      } else {
        // Fallback to detection (less reliable)
        chainId = await this.getChainFromTxHash(txHash);
        this.winstonLogger.warn(
          `No source chain ID provided, detected: ${chainId} (may be inaccurate)`,
        );
      }

      const symbiosisChainId = this.mapToSymbiosis(chainId);

      // STEP 2: Call Symbiosis status API
      const response = (await this.httpService.get(
        `${this.API_BASE_URL}/v2/tx/${symbiosisChainId}/${txHash}`,
        {
          headers: this.buildHeaders(),
          timeout: this.API_TIMEOUT,
        },
      )) as { data: any };

      // STEP 3: Convert to ExecutionStatus format
      return this.convertToExecutionStatus(response.data);
    } catch (error) {
      this.winstonLogger.error(`❌ Symbiosis status check failed`, {
        error: error.message,
        txHash,
        sourceChainId,
        httpStatus: error.response?.status,
        apiError: error.response?.data,
        stack: error.stack?.split('\n').slice(0, 3).join('\n'), // First 3 lines only
      });

      // PRODUCTION FIX: Return structured error with context
      return {
        status: 'unknown',
        message: `Status check failed: ${error.message}`,
        error: {
          code: error.response?.status || 'NETWORK_ERROR',
          details: error.response?.data || error.message,
          txHash,
          sourceChainId,
        },
        timestamp: Date.now(),
      } as any;
    }
  }

  /**
   * Get supported chain pairs for cross-chain routing
   *
   * @returns Object with 'from' and 'to' chain arrays (using internal IDs)
   */
  getSupportedChains(): { from: number[]; to: number[] } {
    // Return chains with proper internal IDs
    // Focus on Tron (195) and major EVM chains
    const chains = [
      1, // Ethereum
      56, // BSC
      137, // Polygon
      42161, // Arbitrum
      10, // Optimism
      43114, // Avalanche
      8453, // Base
      195, // Tron (PRIMARY USE CASE)
    ];

    return { from: chains, to: chains };
  }

  // ============================================================================
  // IProvider IMPLEMENTATION
  // ============================================================================

  /**
   * Get provider name for identification
   */
  getProviderName(): string {
    return 'Symbiosis';
  }

  /**
   * Check if Symbiosis supports a specific chain for on-chain/cross-chain swaps
   * Symbiosis supports 53+ chains including Tron, Bitcoin, and other non-EVM chains
   * Implementation of IMetaAggregator.supportsChain
   */
  supportsChain(chainId: number): boolean {
    // Symbiosis supports chains via internal ID or their API ID mapping
    const supported =
      this.chainIdToSymbiosis.hasOwnProperty(chainId) ||
      // Direct support for standard EVM chains
      [
        1,
        56,
        137,
        42161,
        10,
        43114,
        8453,
        250,
        42220,
        100,
        324,
        1101,
        59144,
        5000,
        534352, // EVM chains
        195,
        728126428, // Tron (both internal and Symbiosis IDs)
        5555,
        3652501241, // Bitcoin (both Rubic and Symbiosis IDs)
        85918,
      ].includes(chainId); // TON

    return supported;
  }

  /**
   * Health check to verify API availability
   */
  async healthCheck(): Promise<ProviderHealth> {
    try {
      const startTime = Date.now();

      // Simple health check: GET /v1/chains
      await this.httpService.get(`${this.API_BASE_URL}/v1/chains`, {
        timeout: 5000,
      });

      const latency = Date.now() - startTime;

      return {
        name: this.getProviderName(),
        status: 'healthy',
        latency,
        lastCheck: new Date(),
      };
    } catch (error) {
      return {
        name: this.getProviderName(),
        status: 'unhealthy',
        error: error.message,
        lastCheck: new Date(),
      } as ProviderHealth;
    }
  }

  /**
   * Get provider configuration
   */
  getConfig(): ProviderConfig {
    return {
      name: 'Symbiosis',
      baseUrl: this.API_BASE_URL,
      enabled: this.envConfig.symbiosisEnabled,
      timeout: this.API_TIMEOUT,
      retries: 2,
      rateLimit: {
        requests: 1,
        perSeconds: 1, // 1 RPS for /v2/swap
      },
    };
  }

  // ============================================================================
  // HELPER METHODS - Chain ID Mapping
  // ============================================================================

  /**
   * Map internal chain ID to Symbiosis format
   *
   * CRITICAL: Handles Tron mapping (195 → 728126428)
   *
   * @param chainId - Internal chain ID (number or string)
   * @returns Symbiosis chain ID (always numeric)
   * @throws Error if chain is not supported by Symbiosis
   */
  private mapToSymbiosis(chainId: number | string): number {
    const mapped = this.chainIdToSymbiosis[chainId];

    if (mapped !== undefined) {
      this.winstonLogger.debug(`Chain ID mapped: ${chainId} → ${mapped}`);
      return mapped;
    }

    // If no explicit mapping, assume standard EVM chain (1:1)
    if (typeof chainId === 'number') {
      this.winstonLogger.debug(
        `Chain ID pass-through (standard EVM): ${chainId}`,
      );
      return chainId;
    }

    // String IDs without mapping are not supported
    throw new Error(
      `Unsupported chain ID for Symbiosis: ${chainId}. Add mapping to chainIdToSymbiosis.`,
    );
  }

  /**
   * Map Symbiosis chain ID back to internal format
   *
   * Used for status tracking and response parsing
   *
   * @param symbiosisId - Symbiosis chain ID
   * @returns Internal chain ID (number or string)
   */
  private mapFromSymbiosis(symbiosisId: number): number | string {
    const mapped = this.symbiosisToChainId[symbiosisId];

    if (mapped !== undefined) {
      return mapped;
    }

    // Standard EVM chains pass through (1:1)
    return symbiosisId;
  }

  // ============================================================================
  // HELPER METHODS - Token & Amount Utilities
  // ============================================================================

  /**
   * Get token decimals from unified configuration
   *
   * @param chainId - Internal chain ID
   * @param tokenAddress - Token address (or 'native')
   * @returns Token decimals (default: 18 for EVM, 6 for Tron)
   */
  private async getTokenDecimals(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<number> {
    try {
      // Handle native tokens
      if (this.isNativeToken(tokenAddress)) {
        return this.getNativeTokenDecimals(chainId);
      }

      // Get from unified config using getTokenDecimals method
      const decimals = this.unifiedConfig.getTokenDecimals(
        tokenAddress,
        chainId,
      );

      if (decimals) {
        return decimals;
      }

      // Default fallback
      return this.getDefaultDecimals(chainId);
    } catch (error) {
      this.winstonLogger.warn(
        `Failed to get decimals for token ${tokenAddress} on chain ${chainId}, using default`,
      );
      return this.getDefaultDecimals(chainId);
    }
  }

  /**
   * Check if token address represents a native token
   */
  private isNativeToken(address: string): boolean {
    const normalized = address.toLowerCase();
    return (
      normalized === 'native' ||
      normalized === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
      normalized === 'eth' ||
      normalized === 'trx' ||
      normalized === 'bnb'
    );
  }

  /**
   * Get native token decimals for a chain
   */
  private getNativeTokenDecimals(chainId: number | string): number {
    // Tron native token (TRX)
    if (chainId === 195 || chainId === 'tron-mainnet' || chainId === 'tron') {
      return 6;
    }

    // Solana native token (SOL)
    if (chainId === 'solana-mainnet' || chainId === 'solana') {
      return 9;
    }

    // Bitcoin
    if (chainId === 5555 || chainId === 'bitcoin-mainnet') {
      return 8;
    }

    // Default EVM chains
    return 18;
  }

  /**
   * Get default decimals for a chain
   */
  private getDefaultDecimals(chainId: number | string): number {
    return this.getNativeTokenDecimals(chainId);
  }

  /**
   * Normalize token address for Symbiosis API
   *
   * Symbiosis expects:
   * - Empty string "" for native tokens (ETH, BNB, TRX, etc.)
   * - Actual contract address for ERC20/TRC20 tokens
   */
  private normalizeTokenAddress(address: string): string {
    if (this.isNativeToken(address)) {
      // Symbiosis uses empty string for native tokens
      return '';
    }
    return address;
  }

  /**
   * Get token symbol for Symbiosis API
   *
   * CRITICAL: Symbiosis requires correct symbols, not addresses!
   * - Native TRX → "TRON" (not "TRX")
   * - Tron USDT → "USDT" (not the address)
   *
   * Extracts the symbol from the token address/identifier
   * For native tokens, returns the chain's native symbol
   * For contract addresses, tries to get from config or returns address
   */
  private getTokenSymbol(
    tokenAddress: string,
    chainId: number | string,
  ): string {
    // Native tokens
    if (this.isNativeToken(tokenAddress)) {
      // Handle string chain IDs first
      if (typeof chainId === 'string') {
        const lowerChainId = chainId.toLowerCase();
        if (lowerChainId === 'tron-mainnet' || lowerChainId === 'tron') {
          return 'TRX'; // Symbiosis uses "TRX" for Tron native token
        }
        if (lowerChainId === 'solana-mainnet' || lowerChainId === 'solana') {
          return 'SOL';
        }
        if (lowerChainId === 'bitcoin-mainnet' || lowerChainId === 'bitcoin') {
          return 'BTC';
        }
      }

      // Handle numeric chain IDs
      const chainIdNum =
        typeof chainId === 'number' ? chainId : parseInt(chainId as string);

      switch (chainIdNum) {
        case 1:
          return 'ETH';
        case 56:
          return 'BNB';
        case 137:
          return 'MATIC';
        case 43114:
          return 'AVAX';
        case 250:
          return 'FTM';
        case 42161:
          return 'ETH'; // Arbitrum
        case 10:
          return 'ETH'; // Optimism
        case 8453:
          return 'ETH'; // Base
        case 195:
          return 'TRX'; // Tron - Symbiosis uses "TRX" for Tron native token
        case 5555:
          return 'BTC'; // Bitcoin
        default:
          return 'NATIVE';
      }
    }

    // Try to get symbol from unified config
    // For now, extract from common token addresses or return a generic name
    const upperAddress = tokenAddress.toUpperCase();

    // Common stablecoins detection
    // Tron USDT: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t (base58) or 0xa614f803b6fd780986a42c78ec9c7f77e6ded13c (hex)
    if (
      upperAddress.includes('USDT') ||
      tokenAddress === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' || // Tron USDT base58
      tokenAddress.toLowerCase() ===
        '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c' // Tron USDT hex
    ) {
      return 'USDT';
    }
    if (upperAddress.includes('USDC')) {
      return 'USDC';
    }
    if (upperAddress.includes('DAI')) {
      return 'DAI';
    }

    // Return address as symbol (Symbiosis will handle it)
    return tokenAddress;
  }

  /**
   * Convert slippage from basis points to percentage
   *
   * @param slippageBps - Slippage in basis points (e.g., 100 = 1%)
   * @returns Slippage percentage (e.g., 1.0)
   */
  private convertSlippage(slippageBps: number): number {
    return (slippageBps / 10000) * 100;
  }

  // ============================================================================
  // HELPER METHODS - Response Conversion
  // ============================================================================

  /**
   * Convert Symbiosis API response to RouteQuote format
   */
  private convertToRouteQuote(data: any, req: RouteRequest): RouteQuote[] {
    try {
      // Handle different response formats
      // Symbiosis may return: { route: [...] }, { routes: [...] }, { data: { route: [...] } } or direct array
      // Note: Symbiosis uses "routes" (plural) for the routing path, not "route"
      const routeData = data.routes || data.route || data.data?.route || data;

      // Log actual response for debugging
      this.winstonLogger.log('📥 Symbiosis response structure', {
        hasRoute: !!data.route,
        hasRoutes: !!data.routes,
        hasDataRoute: !!data.data?.route,
        dataKeys: Object.keys(data || {}),
        firstLevelKeys: data ? Object.keys(data) : [],
        routesLength: Array.isArray(data.routes) ? data.routes.length : 0,
      });

      // Parse the Symbiosis route structure
      // Symbiosis returns "routes" array with routing path (provider, tokens)
      // For on-chain swaps (kind: "onchain-swap"), create a single swap step
      let steps = this.parseSymbiosisRoute(routeData);

      this.winstonLogger.log('🔍 Route parsing debug', {
        stepsLength: steps.length,
        dataKind: data.kind,
        routeDataType: Array.isArray(routeData) ? 'array' : typeof routeData,
        routeDataLength: Array.isArray(routeData) ? routeData.length : 'N/A',
      });

      // If parsing didn't produce steps (e.g., onchain-swap with no detailed route),
      // create a synthetic step based on the swap type
      if (steps.length === 0 && data.kind === 'onchain-swap') {
        this.winstonLogger.log('🚧 Creating synthetic step - conditions met', {
          stepsEmpty: steps.length === 0,
          isOnchainSwap: data.kind === 'onchain-swap',
        });

        // Use the chainId from the transaction data, or map from the request
        const symbiosisChainId =
          data.tx?.chainId || data.tokenAmountIn?.chainId;
        const chainId = symbiosisChainId
          ? this.mapFromSymbiosis(symbiosisChainId)
          : req.fromChainId; // Use request chainId as fallback (already in our format)

        steps = [
          {
            kind: 'swap' as const,
            chainId: chainId,
            details: {
              type: data.kind,
              inTradeType: data.inTradeType,
              outTradeType: data.outTradeType,
              provider: data.routes?.[0]?.provider || 'symbiosis',
              tokens: data.routes?.[0]?.tokens || [],
            },
            protocol: 'symbiosis',
            estimatedTime: data.estimatedTime,
          },
        ];

        this.winstonLogger.log(
          'ℹ️  Created synthetic step for Symbiosis onchain-swap',
          {
            chainId,
            kind: data.kind,
            provider: data.routes?.[0]?.provider,
            symbiosisChainId,
          },
        );
      }

      const route: RouteQuote = {
        steps,
        totalEstimatedOut: data.tokenAmountOut?.amount || data.amountOut || '0',
        fees: {
          gas: data.estimatedGas || data.gas,
          provider:
            data.fees?.[0]?.value?.amount ||
            data.fee?.amount ||
            data.providerFee,
          bridge: data.bridgeFee,
        },
        etaSeconds:
          data.estimatedTime ||
          data.priceImpact?.estimatedTime ||
          data.duration,
        routeId: this.generateRouteId(req),
        providerRef: {
          // Flatten Symbiosis transaction data for MetaExecutor compatibility
          ...data.tx, // Includes: to, data, value, chainId, feeLimit, from, functionSelector
          // Add MetaExecutor expected fields - ensure all amounts are strings
          sellToken: String(req.fromToken),
          buyToken: String(req.toToken),
          sellAmount: String(req.amount), // Original request amount as string
          buyAmount: String(data.tokenAmountOut?.amount || '0'),
          minBuyAmount: String(data.tokenAmountOutMin?.amount || '0'),
          // Symbiosis TRC20/ ERC20 approval target (spender)
          // In Symbiosis JS SDK this is called `approveTo`.
          allowanceTarget:
            (data)?.approveTo ||
            (data)?.approve_to ||
            (data)?.approvalAddress ||
            (data)?.allowanceTarget ||
            '',
          aggregator: 'symbiosis',
          // CRITICAL FIX: Must store complete quote response for /v2/swap execution
          // The Symbiosis /v2/swap endpoint requires the EXACT same payload from /v2/quote
          // We cannot reduce this data without breaking execution
          symbiosisData: {
            // Token configuration (REQUIRED by /v2/swap)
            tokenAmountIn: data.tokenAmountIn,
            tokenOut: data.tokenOut,
            from: data.from,
            to: data.to,
            slippage: data.slippage,
            
            // Swap metadata (REQUIRED by /v2/swap)
            kind: data.kind,
            inTradeType: data.inTradeType,
            outTradeType: data.outTradeType,
            
            // Route information (may be needed)
            routes: data.routes,
            
            // Amount outputs (may be needed)
            tokenAmountOut: data.tokenAmountOut,
            tokenAmountOutMin: data.tokenAmountOutMin,
            
            // Fee information (may be needed)
            fees: data.fees,
            estimatedGas: data.estimatedGas,
            
            // Timing (may be needed)
            estimatedTime: data.estimatedTime,
            
            // Transaction data (NOT sent to /v2/swap, but needed for backup)
            tx: data.tx,
            
            // Approval data (may be needed)
            approveTo: data.approveTo,
            approve_to: data.approve_to,
            approvalAddress: data.approvalAddress,
          },
          timestamp: Date.now(),
        },
      };

      return [route];
    } catch (error) {
      this.winstonLogger.error('❌ Failed to convert Symbiosis response', {
        error: error.message,
        stack: error.stack,
        responseKeys: data ? Object.keys(data) : [],
        sampleData: data
          ? JSON.stringify(data).substring(0, 500)
          : 'undefined or null',
      });
      throw error;
    }
  }

  /**
   * Check if an error is retryable
   * 
   * PRODUCTION FIX: Determines which errors should trigger retry logic
   * 
   * @param error - Error object from HTTP request
   * @returns true if error is retryable (network errors, 5xx, 429)
   */
  private isRetryableError(error: any): boolean {
    // Network errors (no response)
    if (!error.response) {
      return true;
    }

    const status = error.response?.status;
    
    // Retryable HTTP status codes
    return (
      status === 429 || // Rate limit
      status === 503 || // Service unavailable
      status === 504 || // Gateway timeout
      status === 502 || // Bad gateway
      (status >= 500 && status < 600) // Other 5xx errors
    );
  }

  /**
   * Validate Symbiosis API response structure
   * 
   * PRODUCTION FIX: Prevents crashes from unexpected API response formats
   * 
   * @param data - Response data from Symbiosis API
   * @throws Error if response is invalid
   */
  private validateSymbiosisResponse(data: any): void {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid Symbiosis response: data is null or not an object');
    }

    // Check for error response from API
    if (data.error || data.message) {
      throw new Error(`Symbiosis API error: ${data.error || data.message}`);
    }

    // Validate required fields based on response type
    if (data.kind === 'onchain-swap' || data.kind === 'crosschain-swap') {
      if (!data.tokenAmountOut && !data.amountOut) {
        this.winstonLogger.warn('Symbiosis response missing output amount', {
          dataKeys: Object.keys(data),
        });
      }
      
      if (!data.tx || typeof data.tx !== 'object') {
        this.winstonLogger.warn('Symbiosis response missing transaction data', {
          hasTx: !!data.tx,
          txType: typeof data.tx,
        });
      }
    }
  }

  /**
   * Parse Symbiosis route array into Step format
   */
  private parseSymbiosisRoute(route: any[]): Step[] {
    if (!Array.isArray(route) || route.length === 0) {
      return [];
    }

    return route.map((step, index) => ({
      kind: this.determineStepKind(step),
      chainId: this.mapFromSymbiosis(step.chainId || 0),
      details: step,
      protocol: step.protocol || step.provider || 'symbiosis',
      estimatedTime: step.estimatedTime,
    }));
  }

  /**
   * Determine step kind from Symbiosis step data
   */
  private determineStepKind(step: any): 'swap' | 'bridge' | 'native' {
    const type = step.type?.toLowerCase() || '';

    if (type.includes('bridge') || type.includes('cross')) {
      return 'bridge';
    }

    if (type.includes('swap') || type.includes('trade')) {
      return 'swap';
    }

    return 'native';
  }

  /**
   * Convert Symbiosis status response to ExecutionStatus
   */
  private convertToExecutionStatus(data: any): ExecutionStatus {
    const status = data.status?.toLowerCase() || 'unknown';

    return {
      status:
        status === 'completed'
          ? 'completed'
          : status === 'pending'
            ? 'pending'
            : status === 'failed'
              ? 'failed'
              : 'unknown',
      txHash: data.txHash || data.transactionHash,
      message: data.message || data.error,
      timestamp: Date.now(),
      steps: data.steps || [],
    } as any;
  }

  // ============================================================================
  // HELPER METHODS - Utilities
  // ============================================================================

  /**
   * Generate unique route ID
   */
  private generateRouteId(req: RouteRequest): string {
    const timestamp = Date.now();
    const hash = `${req.fromChainId}-${req.toChainId}-${req.amount}-${timestamp}`;
    return `symbiosis-${hash}`;
  }

  /**
   * Build HTTP headers for Symbiosis API
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.PARTNER_ID) {
      headers['X-Partner-Id'] = this.PARTNER_ID;
    }

    return headers;
  }

  /**
   * Detect chain ID from transaction hash format
   *
   * Uses heuristics to determine the source chain based on transaction hash characteristics:
   * - Length, character set, and patterns
   *
   * Supported detection:
   * - Tron: 64-char hex (same as EVM, needs context)
   * - EVM: 64-char hex starting with 0x (66 chars total)
   * - Bitcoin: Various lengths (64+ chars, base58)
   * - Solana: 88 chars base58
   *
   * @param txHash - Transaction hash to analyze
   * @returns Detected chain ID (defaults to Ethereum if uncertain)
   */
  private async getChainFromTxHash(
    txHash: string,
  ): Promise<number | string> {
    const normalized = txHash.toLowerCase().trim();

    // Remove 0x prefix if present
    const cleanHash = normalized.startsWith('0x')
      ? normalized.slice(2)
      : normalized;

    // Solana: Base58 encoded, typically 87-88 characters
    // Example: 5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW
    if (cleanHash.length >= 87 && cleanHash.length <= 90) {
      if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(cleanHash)) {
        this.winstonLogger.debug('Detected Solana transaction hash');
        return 'solana-mainnet';
      }
    }

    // Bitcoin: Base58 encoded, typically 64 characters
    // Example: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa
    if (cleanHash.length === 64 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(cleanHash)) {
      this.winstonLogger.debug('Detected Bitcoin transaction hash (base58)');
      return 5555; // Bitcoin
    }

    // Tron: 64-char hex (without 0x prefix)
    // Tron transactions are hex but don't use 0x prefix in their native format
    // However, Tron can also be represented with 0x prefix when interacting with some APIs
    // Example: 7c2d4c9349e8a9c0d3f8e8c8b8d8c8b8d8c8b8d8c8b8d8c8b8d8c8b8d8c8b8d8
    if (
      cleanHash.length === 64 &&
      /^[0-9a-f]+$/.test(cleanHash) &&
      !normalized.startsWith('0x')
    ) {
      // Could be Tron or other chains
      // Without additional context, we cannot definitively determine
      // For safety, we'll return Ethereum but log a warning
      this.winstonLogger.warn(
        'Ambiguous transaction hash format (64-char hex without 0x). Could be Tron, Ethereum, or other EVM chains. Defaulting to Ethereum. Consider passing sourceChainId explicitly.',
        { txHash },
      );
      return 1; // Default to Ethereum for EVM-compatible chains
    }

    // EVM chains: 66-char hex (with 0x prefix) or 64-char hex
    // Example: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
    if (cleanHash.length === 64 && /^[0-9a-f]+$/.test(cleanHash)) {
      this.winstonLogger.debug('Detected EVM transaction hash');
      return 1; // Ethereum as default EVM chain
    }

    // Unknown format - default to Ethereum
    this.winstonLogger.warn(
      'Unknown transaction hash format. Defaulting to Ethereum. Consider passing sourceChainId explicitly.',
      {
        txHash,
        cleanHashLength: cleanHash.length,
        pattern: cleanHash.substring(0, 10) + '...',
      },
    );
    return 1;
  }
}
