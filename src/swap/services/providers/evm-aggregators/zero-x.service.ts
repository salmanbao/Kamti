import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  Optional,
} from '@nestjs/common';
import { CustomHttpService } from '@shared/services/http.service';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';
import { AmountNormalizationUtils } from '@shared/utils/amount-normalization.utils';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  ApprovalStrategy,
  AggregatorType,
} from '@swap/models/swap-request.model';
import {
  IOnchainAggregator,
  SwapRequest,
  SwapQuote,
  TransactionBuild,
  ProviderConfig,
  ProviderHealth,
  IProvider,
} from '@swap/models/ports';
import {
  ZeroXQuoteResponse,
  ApiErrorResponse,
  isApiErrorResponse,
  ZeroXTokenInfo,
  ZeroXTokenListResponse,
} from '@swap/models/aggregator-responses';
import { NATIVE_TOKEN_ADDRESS, USDT_ADDRESS } from '@shared/utils/chain.utils';
import {
  convertToProviderFormat,
  ProviderType,
} from '@shared/utils/token-address.utils';
import type { IAggregatorRegistry } from '@swap/services/core/aggregation/aggregator-registry.interface';
import { AggregatorManagerService } from '@swap/services/core/aggregation/aggregator-manager.service';

/**
 * 0x Protocol v2 aggregator service implementing IOnchainAggregator port
 * Uses AllowanceHolder approval strategy
 * NOW WITH SELF-REGISTRATION: Automatically registers itself with AggregatorManagerService
 */
@Injectable()
export class ZeroXService
  implements IOnchainAggregator, IProvider, OnModuleInit
{
  private readonly baseUrl = 'https://api.0x.org';
  private readonly apiKey: string | undefined;

  // Cache for AllowanceHolder addresses to avoid repeated API calls
  private readonly allowanceTargetCache = new Map<
    number,
    { address: string; timestamp: number }
  >();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly supportedChains = [
    1, 10, 14, 56, 130, 137, 143, 480, 5000, 8453, 9745, 10143, 34443, 42161,
    43114, 59144, 81457, 534352, 57073, 80094,
  ];

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly envConfig: EnvironmentConfigService,
    private readonly amountUtils: AmountNormalizationUtils,
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly winstonLogger: WinstonLoggerService,
    @Optional()
    @Inject(AggregatorManagerService)
    private readonly registry?: IAggregatorRegistry,
  ) {
    this.apiKey = envConfig.zeroxApiKey;
    this.winstonLogger.setContext('ZeroXService');
  }

  /**
   * Self-register with aggregator manager on module initialization
   */
  onModuleInit() {
    if (this.registry) {
      this.registry.registerEvmAggregator(this);
      this.winstonLogger.debug(
        `${this.getProviderName()} self-registered with aggregator manager`,
      );
    } else {
      this.winstonLogger.warn(
        `${this.getProviderName()} could not find registry to self-register`,
      );
    }
  }

  /**
   * Get provider name for identification
   */
  getProviderName(): string {
    return '0x';
  }

  /**
   * Check if provider supports the given chain
   */
  supportsChain(chainId: number): boolean {
    // 0x Protocol v2 supports these chains (hardcoded fallback)
    return this.supportedChains.includes(chainId);
  }

  /**
   * Get all supported chains dynamically from 0x API
   */
  async getSupportedChains(): Promise<number[]> {
    try {
      const url = `${this.baseUrl}/swap/chains`;
      const headers = this.buildHeaders();

      this.winstonLogger.debug('Fetching supported chains from 0x API');

      const response = await this.httpService.get<{
        chains: Array<{ chainId: number }>;
      }>(url, {
        headers,
        timeout: 10000,
      });

      const chainIds = response.chains?.map((record) => record.chainId) || [];

      this.winstonLogger.debug(
        `0x API returned ${chainIds.length} supported chains: ${chainIds.join(', ')}`,
      );

      return chainIds.filter((chainId) => chainId > 0);
    } catch (error) {
      this.winstonLogger.warn(
        `Failed to fetch supported chains from 0x API: ${error.message}, using hardcoded list`,
      );

      // Fallback to hardcoded list
      return this.supportedChains;
    }
  }

  /**
   * Get swap quote - implements IOnchainAggregator interface
   */
  async getQuote(
    request: SwapRequest,
    strictValidation: boolean = true,
  ): Promise<SwapQuote> {
    const strategy =
      request.approvalStrategy || ApprovalStrategy.ALLOWANCE_HOLDER;
    return this.getQuoteWithStrategy(request, strategy, strictValidation);
  }

  /**
   * Build transaction data - implements IOnchainAggregator interface
   */
  async buildTx(request: SwapRequest): Promise<TransactionBuild> {
    const quote = await this.getQuote(request);
    return {
      to: quote.to,
      data: quote.data,
      value: quote.value,
      gasLimit: quote.gas,
      gasPrice: quote.gasPrice,
    };
  }

  /**
   * Provider health check
   */
  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Simple health check with ETH price query using AllowanceHolder
      await this.httpService.get(
        `${this.baseUrl}/swap/allowance-holder/price?chainId=1&sellToken=${NATIVE_TOKEN_ADDRESS}&buyToken=${USDT_ADDRESS}&sellAmount=1000000000000000000`,
        {
          headers: this.buildHeaders(),
          timeout: 5000,
        },
      );

      const latency = Date.now() - startTime;
      return {
        name: this.getProviderName(),
        status: 'healthy',
        latency,
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
      baseUrl: this.baseUrl,
      apiKey: this.apiKey ? '***' : undefined,
      enabled: true,
      rateLimit: {
        requests: 10,
        perSeconds: 1,
      },
      timeout: 15000,
      retries: 3,
    };
  }

  /**
   * Clear the allowance target cache (useful for testing or when addresses change)
   */
  clearAllowanceTargetCache(): void {
    this.allowanceTargetCache.clear();
    this.winstonLogger.debug('AllowanceTarget cache cleared');
  }

  /**
   * Get price using AllowanceHolder strategy
   */
  async getPrice(request: SwapRequest): Promise<any> {
    return this.getPriceWithStrategy(
      request,
      ApprovalStrategy.ALLOWANCE_HOLDER,
    );
  }

  /**
   * Get swap quote with specified approval strategy
   */
  async getQuoteWithStrategy(
    request: SwapRequest,
    strategy: ApprovalStrategy,
    strictValidation: boolean = true,
  ): Promise<SwapQuote> {
    const startTime = Date.now();

    try {
      const url = `${this.baseUrl}/swap/${strategy}/quote?`;
      const params = this.buildQuoteParams(request);
      const headers = this.buildHeaders();
      const quoteParams = new URLSearchParams({ ...params });

      this.winstonLogger.debug(
        `Getting 0x v2 ${strategy} quote for chain ${request.chainId}`,
      );
      const response = await this.httpService.get<ZeroXQuoteResponse>(
        url + quoteParams.toString(),
        {
          headers,
          timeout: 15000,
        },
      );

      // Validate response before parsing - use strict or relaxed validation
      this.validateQuoteResponse(response, request, strictValidation);

      const result = this.parseQuoteResponse(response, request, strategy);

      const duration = Date.now() - startTime;

      // Audit log successful quote
      this.winstonLogger.audit('AGGREGATOR_QUOTE_SUCCESS', {
        aggregator: '0x',
        strategy,
        chainId: request.chainId,
        sellToken: request.sellToken,
        buyToken: request.buyToken,
        sellAmount: request.sellAmount,
        buyAmount: result.buyAmount,
        priceImpact: result.priceImpact,
        gasEstimate: result.estimatedGas,
        duration,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log quote failure
      this.winstonLogger.audit('AGGREGATOR_QUOTE_FAILED', {
        aggregator: '0x',
        strategy,
        chainId: request.chainId,
        sellToken: request.sellToken,
        buyToken: request.buyToken,
        sellAmount: request.sellAmount,
        error: error.message,
        errorType: this.categorizeError(error),
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to get 0x v2 ${strategy} quote: ${error.message}`,
        error.stack,
      );

      // Use specific error handling
      if (error.response || error.request) {
        this.handleApiError(error, `getQuoteWithStrategy(${strategy})`);
      }

      throw new Error(`0x v2 ${strategy} quote failed: ${error.message}`);
    }
  }

  /**
   * Get spender address for approvals (AllowanceHolder only)
   */
  async getSpenderAddress(chainId: number): Promise<string> {
    try {
      // Get the AllowanceHolder address dynamically from quote response
      return await this.getAllowanceHolderAddressDynamic(chainId);
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get spender address: ${error.message}`,
      );
      throw new Error(`Failed to get spender address: ${error.message}`);
    }
  }

  /**
   * Get token list for a chain (0x v2)
   */
  async getTokenList(chainId: number): Promise<ZeroXTokenInfo[]> {
    try {
      const url = `${this.baseUrl}/swap/v1/tokens`;
      const headers = this.buildHeaders();

      const response = await this.httpService.get<ZeroXTokenListResponse>(url, {
        headers,
        timeout: 10000,
      });

      return response.records || [];
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get 0x v2 token list: ${error.message}`,
      );
      throw new Error(`Failed to get 0x v2 token list: ${error.message}`);
    }
  }

  /**
   * Get price quote with specified approval strategy
   */
  async getPriceWithStrategy(
    request: SwapRequest,
    strategy: ApprovalStrategy,
  ): Promise<any> {
    try {
      const url = `${this.baseUrl}/swap/${strategy}/price`;
      const params = this.buildQuoteParams(request);
      const headers = this.buildHeaders();
      const queryParams = new URLSearchParams(params);

      this.winstonLogger.debug(
        `Getting 0x v2 ${strategy} price for chain ${request.chainId}`,
      );

      const response = await this.httpService.get<any>(
        url + '?' + queryParams.toString(),
        {
          headers,
          timeout: 10000,
        },
      );

      return response;
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get 0x v2 ${strategy} price: ${error.message}`,
        error.stack,
      );
      throw new Error(`0x v2 ${strategy} price failed: ${error.message}`);
    }
  }

  /**
   * Build query parameters for 0x v2 quote request
   */
  private buildQuoteParams(request: SwapRequest): Record<string, string> {
    // Convert token addresses to 0x's expected format (0xeeee... for native)
    const sellToken = convertToProviderFormat(
      request.sellToken,
      ProviderType.ZERO_X,
    );
    const buyToken = convertToProviderFormat(
      request.buyToken,
      ProviderType.ZERO_X,
    );

    // Get token decimals for amount normalization (default to 18 if not found)
    const sellTokenDecimals = this.getTokenDecimals(
      request.sellToken,
      request.chainId,
    );

    // Normalize sell amount to wei format (0x expects wei)
    const normalizedSellAmount = this.amountUtils.normalizeForProvider(
      request.sellAmount,
      sellTokenDecimals,
      '0x',
      'buildQuoteParams',
    );

    const params: Record<string, string> = {
      chainId: request.chainId.toString(),
      sellToken,
      buyToken,
      sellAmount: normalizedSellAmount,
      taker: request.taker,
    };

    // Add slippage in basis points (0x v2 uses bps instead of percentage)
    if (request.slippagePercentage !== undefined) {
      const slippageBps = Math.round(request.slippagePercentage * 100);
      params.slippageBps = slippageBps.toString();
    }

    // Add txOrigin if taker is different from recipient (for smart contracts)
    if (request.recipient && request.recipient !== request.taker) {
      params.txOrigin = request.recipient;
    }

    return params;
  }

  /**
   * Get token decimals for a given token address
   * Attempts to find decimals from unified configuration, falls back to defaults
   */
  private getTokenDecimals(tokenAddress: string, chainId: number): number {
    // Delegate to unified configuration for consistent overrides
    return this.unifiedConfig.getTokenDecimals(tokenAddress, chainId);
  }

  /**
   * Build headers for 0x v2 API requests
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      '0x-version': 'v2',
    };

    if (this.apiKey) {
      headers['0x-api-key'] = this.apiKey;
    }

    return headers;
  }

  /**
   * Parse 0x v2 quote response
   */
  private parseQuoteResponse(
    response: ZeroXQuoteResponse,
    request: SwapRequest,
    strategy: ApprovalStrategy,
  ): SwapQuote {
    // Handle 0x v2 response format
    const minBuyAmount = response.minBuyAmount || response.buyAmount;

    // Extract transaction data (to, data, value, gas, gasPrice)
    const transaction = response.transaction;

    return {
      sellToken: response.sellToken,
      buyToken: response.buyToken,
      sellAmount: response.sellAmount,
      buyAmount: response.buyAmount,
      minBuyAmount: minBuyAmount.toString(),
      gas: transaction.gas || response.gas || response.estimatedGas || '',
      gasPrice: transaction.gasPrice || response.gasPrice,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      allowanceTarget: response.allowanceTarget,
      aggregator: AggregatorType.ZEROX, // Use enum value instead of string
      priceImpact: response.priceImpact,
      estimatedGas: response.estimatedGas || response.gas,
      approvalStrategy: strategy,
      // Add timestamp for expiry validation
      timestamp: Date.now(),
      // Add EIP-1559 gas fields if available
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      // Add liquidity validation fields
      liquidityAvailable: response.liquidityAvailable,
      issues: response.issues,
    };
  }

  /**
   * Get AllowanceHolder contract address dynamically from 0x API
   * This is the recommended approach per 0x documentation
   */
  private async getAllowanceHolderAddressDynamic(
    chainId: number,
  ): Promise<string> {
    const startTime = Date.now();

    try {
      // Check cache first
      const cached = this.allowanceTargetCache.get(chainId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        this.winstonLogger.debug(
          `Using cached AllowanceHolder address for chain ${chainId}: ${cached.address}`,
        );
        return cached.address;
      }

      // Make a small quote request to get the current allowanceTarget
      const url = `${this.baseUrl}/swap/allowance-holder/quote`;
      const params = new URLSearchParams({
        chainId: chainId.toString(),
        sellToken: NATIVE_TOKEN_ADDRESS, // Use native token (ETH, BNB, etc.)
        buyToken: USDT_ADDRESS, // Use a common stable token
        sellAmount: '1000000000000000000', // 1 token
        taker: '0x0000000000000000000000000000000000000000', // Dummy address for quote
      });

      const headers = this.buildHeaders();

      this.winstonLogger.debug(
        `Getting dynamic AllowanceHolder address for chain ${chainId}`,
      );

      const response = await this.httpService.get<any>(
        url + '?' + params.toString(),
        {
          headers,
          timeout: 10000,
        },
      );

      if (response.allowanceTarget) {
        const address = response.allowanceTarget;
        const duration = Date.now() - startTime;

        // Cache the result
        this.allowanceTargetCache.set(chainId, {
          address,
          timestamp: Date.now(),
        });

        // Audit log Permit2/AllowanceHolder address retrieval
        this.winstonLogger.audit('AGGREGATOR_PERMIT2_ADDRESS_RETRIEVED', {
          aggregator: '0x',
          chainId,
          allowanceHolderAddress: address,
          cached: false,
          duration,
          timestamp: new Date().toISOString(),
        });

        this.winstonLogger.debug(
          `Dynamic AllowanceHolder address for chain ${chainId}: ${address} (cached)`,
        );
        return address;
      } else {
        // Fallback to hardcoded addresses if allowanceTarget is not in response
        this.winstonLogger.warn(
          `No allowanceTarget in response for chain ${chainId}, falling back to hardcoded address`,
        );
        return this.getAllowanceHolderAddressFallback(chainId);
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log failure
      this.winstonLogger.audit('AGGREGATOR_PERMIT2_ADDRESS_FAILED', {
        aggregator: '0x',
        chainId,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.warn(
        `Failed to get dynamic AllowanceHolder address for chain ${chainId}: ${error.message}, falling back to hardcoded`,
      );
      // Fallback to hardcoded addresses if API call fails
      return this.getAllowanceHolderAddressFallback(chainId);
    }
  }

  /**
   * Get AllowanceHolder contract address for a specific chain (fallback method)
   * These are backup addresses in case the dynamic method fails
   */
  private getAllowanceHolderAddressFallback(chainId: number): string {
    // AllowanceHolder contract addresses by hardfork type (as of last update)
    // Note: These may become outdated - dynamic method above is preferred
    const cancunChains = [1, 10, 56, 137, 8453, 11155111, 42161, 43114, 81457];
    const shanghaiChains = [5000, 534352];
    const londonChains = [59144];

    if (cancunChains.includes(chainId)) {
      return '0x0000000000001fF3684f28c67538d4D072C22734';
    } else if (shanghaiChains.includes(chainId)) {
      return '0x0000000000005E88410CcDFaDe4a5EfaE4b49562';
    } else if (londonChains.includes(chainId)) {
      return '0x000000000000175a8b9bC6d539B3708EEd92EA6c';
    } else {
      throw new Error(`AllowanceHolder not supported on chain ${chainId}`);
    }
  }

  /**
   * Validate quote response and handle edge cases
   */
  private validateQuoteResponse(
    response: ZeroXQuoteResponse | ApiErrorResponse,
    request: SwapRequest,
    strictValidation: boolean = true,
  ): void {
    if (!response) {
      throw new Error('Empty response from 0x API');
    }

    // Check if it's an error response
    if (isApiErrorResponse(response)) {
      const errors = response.detail.map((d) => d.msg).join(', ');
      throw new Error(`0x API error: ${errors}`);
    }

    if (!response.buyAmount || !response.sellAmount) {
      throw new Error(
        'Invalid quote response: missing buyAmount or sellAmount',
      );
    }

    if (!response.transaction.to || !response.transaction.data) {
      throw new Error('Invalid quote response: missing transaction data');
    }

    // Check for liquidity issues - more relaxed when not doing strict validation
    if (response.issues) {
      // Handle both array and object formats for issues
      if (Array.isArray(response.issues)) {
        const issues = response.issues;
        // Always check for critical liquidity issues
        if (issues.includes('INSUFFICIENT_LIQUIDITY')) {
          if (strictValidation) {
            throw new Error('Insufficient liquidity for this trade');
          } else {
            this.winstonLogger.warn(
              'Insufficient liquidity detected in quote - may affect execution',
            );
          }
        }
        if (issues.includes('INVALID_SOURCES')) {
          if (strictValidation) {
            throw new Error('Invalid liquidity sources');
          } else {
            this.winstonLogger.warn(
              'Invalid liquidity sources detected in quote',
            );
          }
        }
      } else {
        // Handle object format
        const issues = response.issues;
        // For balance/allowance issues, only warn during quote comparison
        if (issues.balance || issues.allowance) {
          if (strictValidation) {
            throw new Error('Balance or allowance issues detected');
          } else {
            this.winstonLogger.warn(
              'Balance or allowance issues detected in quote - will need to be resolved before execution',
            );
          }
        }
        if (issues.simulationIncomplete) {
          this.winstonLogger.warn('Simulation incomplete for this trade');
        }
      }
    }

    // Check if liquidity is available - more relaxed for quote comparison
    if (response.liquidityAvailable === false) {
      if (strictValidation) {
        throw new Error('No liquidity available for this trade');
      } else {
        this.winstonLogger.warn(
          'No liquidity available according to 0x - quote may not be executable',
        );
      }
    }

    // Validate minimum buy amount
    const minBuyAmount = BigInt(response.minBuyAmount || response.buyAmount);
    const buyAmount = BigInt(response.buyAmount);

    if (minBuyAmount > buyAmount) {
      throw new Error('Invalid quote: minBuyAmount greater than buyAmount');
    }

    this.winstonLogger.debug(
      `Quote validation passed for ${request.sellToken} -> ${request.buyToken}${strictValidation ? ' (strict)' : ' (relaxed)'}`,
    );
  }

  /**
   * Handle API errors with specific error messages
   */
  private handleApiError(error: any, context: string): never {
    const errorType = this.categorizeError(error);

    // Audit log API error
    this.winstonLogger.audit('AGGREGATOR_API_ERROR', {
      aggregator: '0x',
      context,
      errorType,
      statusCode: error.response?.status,
      errorMessage: error.message,
      timestamp: new Date().toISOString(),
    });

    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      // Check if it's a structured API error response
      if (isApiErrorResponse(data)) {
        const errors = data.detail.map((d) => d.msg).join(', ');
        throw new Error(`${context}: ${errors}`);
      }

      switch (status) {
        case 400:
          throw new Error(
            `Bad request: ${data?.message || 'Invalid parameters'}`,
          );
        case 401:
          throw new Error('Unauthorized: Invalid API key');
        case 403:
          throw new Error(
            'Forbidden: API key does not have required permissions',
          );
        case 404:
          throw new Error('Not found: Endpoint or resource not found');
        case 429:
          throw new Error('Rate limited: Too many requests');
        case 500:
          throw new Error(
            'Internal server error: 0x API is experiencing issues',
          );
        case 503:
          throw new Error('Service unavailable: 0x API is temporarily down');
        default:
          throw new Error(
            `API error (${status}): ${data?.message || 'Unknown error'}`,
          );
      }
    } else if (error.request) {
      throw new Error('Network error: Unable to reach 0x API');
    } else {
      throw new Error(`Request setup error: ${error.message}`);
    }
  }

  /**
   * Categorize error for analytics
   */
  private categorizeError(error: any): string {
    if (error.response) {
      const status = error.response.status;
      if (status === 429) return 'rate_limit';
      if (status >= 400 && status < 500) return 'client_error';
      if (status >= 500) return 'server_error';
      return 'api_error';
    } else if (error.request) {
      return 'network_error';
    } else if (error.message?.toLowerCase().includes('liquidity')) {
      return 'insufficient_liquidity';
    } else if (error.message?.toLowerCase().includes('timeout')) {
      return 'timeout';
    } else if (error.message?.toLowerCase().includes('balance')) {
      return 'insufficient_balance';
    } else if (error.message?.toLowerCase().includes('allowance')) {
      return 'insufficient_allowance';
    }
    return 'unknown_error';
  }
}
