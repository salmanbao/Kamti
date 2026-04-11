import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  SwapRequest,
  SwapQuote,
  AggregatorType,
  ApprovalStrategy,
} from '@swap/models/swap-request.model';
import {
  IOnchainAggregator,
  IMetaAggregator,
  ISolanaRouter,
  RouteRequest,
  RouteQuote,
  TransactionBuild,
  ProviderHealth,
  IProvider,
  SwapQuote as PortsSwapQuote,
  SwapRequest as PortsSwapRequest,
} from '@swap/models/ports';
import {
  IAggregatorRegistry,
  ProviderCategory,
} from './aggregator-registry.interface';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { ProviderHealthService } from '@shared/services/provider-health.service';
import { BlockchainEcosystem } from '@swap/dto/universal-swap-request.dto';

/**
 * Unified aggregator manager service that coordinates with multiple provider types
 * Supports legacy EVM aggregators (0x Protocol, Odos) with backward compatibility
 * Enhanced with multi-provider architecture: Meta aggregators, Solana routers
 * Uses provider ports pattern for loose coupling while maintaining legacy API compatibility
 *
 * NOW WITH SELF-REGISTRATION: Providers register themselves automatically via IAggregatorRegistry
 */
@Injectable()
export class AggregatorManagerService implements IAggregatorRegistry {
  // Legacy aggregator registry for backward compatibility
  private readonly aggregators: Map<AggregatorType, any> = new Map();

  // Enhanced provider registries by type
  private readonly evmAggregators: Map<string, IOnchainAggregator> = new Map();
  private readonly metaAggregators: Map<string, IMetaAggregator> = new Map();
  private readonly solanaRouters: Map<string, ISolanaRouter> = new Map();

  // In-memory cache for cross-chain routes (meta aggregators): routeId -> provider + providerRef
  private readonly crossChainRouteCache: Map<
    string,
    { providerName: string; providerRef: any; expiresAt: number }
  > = new Map();
  private readonly crossChainRouteCacheTtlMs = 10 * 60 * 1000; // 10 minutes

  // Provider health cache
  private readonly healthCache: Map<string, ProviderHealth> = new Map();
  private readonly healthCacheTimeout = 5 * 60 * 1000; // 5 minutes

  // Track registration stats
  private registrationComplete = false;

  constructor(
    private readonly unifiedConfigService: UnifiedConfigurationService,
    private readonly winstonLogger: WinstonLoggerService,
    private readonly providerHealth: ProviderHealthService,
  ) {
    this.winstonLogger.setContext('AggregatorManagerService');
    this.winstonLogger.log(
      '🚀 AggregatorManagerService initialized - awaiting provider self-registration',
    );
  }

  // ============================================================================
  // SELF-REGISTRATION API (IAggregatorRegistry implementation)
  // ============================================================================

  /**
   * Register an EVM aggregator (called by providers themselves)
   */
  registerEvmAggregator(provider: IOnchainAggregator): void {
    const name = provider.getProviderName();

    if (this.evmAggregators.has(name)) {
      this.winstonLogger.warn(
        `⚠️ EVM aggregator '${name}' already registered, skipping duplicate`,
      );
      return;
    }

    this.evmAggregators.set(name, provider);

    // Also register in legacy map if it's 0x or Odos
    this.registerInLegacyMap(name, provider);

    this.winstonLogger.log(`✅ Self-registered EVM aggregator: ${name}`);
  }

  /**
   * Register a meta aggregator (called by providers themselves)
   */
  registerMetaAggregator(provider: IMetaAggregator): void {
    const name = provider.getProviderName();

    if (this.metaAggregators.has(name)) {
      this.winstonLogger.warn(
        `⚠️ Meta aggregator '${name}' already registered, skipping duplicate`,
      );
      return;
    }

    this.metaAggregators.set(name, provider);
    this.winstonLogger.log(`✅ Self-registered Meta aggregator: ${name}`);
  }

  /**
   * Register a Solana router (called by providers themselves)
   */
  registerSolanaRouter(provider: ISolanaRouter): void {
    const name = provider.getProviderName();

    if (this.solanaRouters.has(name)) {
      this.winstonLogger.warn(
        `⚠️ Solana router '${name}' already registered, skipping duplicate`,
      );
      return;
    }

    this.solanaRouters.set(name, provider);
    this.winstonLogger.log(`✅ Self-registered Solana router: ${name}`);
  }

  /**
   * Generic registration method (auto-detects category)
   */
  registerProvider(provider: any, category: ProviderCategory): void {
    switch (category) {
      case ProviderCategory.EVM_AGGREGATOR:
        this.registerEvmAggregator(provider);
        break;
      case ProviderCategory.META_AGGREGATOR:
        this.registerMetaAggregator(provider);
        break;
      case ProviderCategory.SOLANA_ROUTER:
        this.registerSolanaRouter(provider);
        break;
      default:
        this.winstonLogger.error(`Unknown provider category: ${category}`);
    }
  }

  /**
   * Mark registration as complete and log summary
   */
  onRegistrationComplete(): void {
    if (this.registrationComplete) return;

    this.registrationComplete = true;
    this.winstonLogger.log(
      `📊 Provider registration complete - ` +
        `Legacy(${this.aggregators.size}), ` +
        `EVM(${this.evmAggregators.size}), ` +
        `Meta(${this.metaAggregators.size}), ` +
        `Solana(${this.solanaRouters.size})`,
    );

    // Log registered providers
    if (this.evmAggregators.size > 0) {
      this.winstonLogger.log(
        `  📍 EVM Aggregators: ${Array.from(this.evmAggregators.keys()).join(', ')}`,
      );
    }
    if (this.metaAggregators.size > 0) {
      this.winstonLogger.log(
        `  🌉 Meta Aggregators: ${Array.from(this.metaAggregators.keys()).join(', ')}`,
      );
    }
    if (this.solanaRouters.size > 0) {
      this.winstonLogger.log(
        `  ☀️ Solana Routers: ${Array.from(this.solanaRouters.keys()).join(', ')}`,
      );
    }
  }

  /**
   * Register provider in legacy map for backward compatibility
   */
  private registerInLegacyMap(name: string, provider: any): void {
    const lowerName = name.toLowerCase();

    if (lowerName === '0x') {
      this.aggregators.set(AggregatorType.ZEROX, provider);
      this.winstonLogger.debug(`  ↳ Also registered in legacy map as ZEROX`);
    } else if (lowerName === 'odos') {
      this.aggregators.set(AggregatorType.ODOS, provider);
      this.winstonLogger.debug(`  ↳ Also registered in legacy map as ODOS`);
    }
  }

  // ============================================================================
  // TYPE CONVERSION UTILITIES
  // ============================================================================

  /**
   * Convert legacy SwapRequest to ports SwapRequest
   */
  private convertToPortsRequest(request: SwapRequest): PortsSwapRequest {
    return {
      chainId: request.chainId,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmount: request.sellAmount,
      taker: request.taker,
      recipient: request.recipient,
      slippagePercentage: request.slippagePercentage,
      deadline: request.deadline,
      aggregator: request.aggregator || AggregatorType.ZEROX, // Use enum default
    };
  }

  /**
   * Convert ports SwapQuote to legacy SwapQuote
   */
  private convertToLegacyQuote(
    quote: PortsSwapQuote,
    providerName: string,
  ): SwapQuote {
    // Map provider name to AggregatorType
    let aggregatorType: AggregatorType;
    switch (providerName.toLowerCase()) {
      case '0x':
        aggregatorType = AggregatorType.ZEROX;
        break;
      case 'odos':
        aggregatorType = AggregatorType.ODOS;
        break;
      default:
        aggregatorType = AggregatorType.ZEROX; // Default fallback
    }

    return {
      ...quote,
      aggregator: aggregatorType,
    };
  }

  /**
   * Convert RouteQuote (from meta aggregators like Rubic) to SwapQuote format
   * Used when Rubic is used as a fallback for EVM swaps
   * Now includes enhanced fee and amount details from RouteQuote
   */
  private convertRouteQuoteToSwapQuote(
    route: RouteQuote,
    providerName: string,
  ): SwapQuote {
    const providerRef = route.providerRef || {};
    return {
      sellToken: providerRef.sellToken || '', // From providerRef if available
      buyToken: providerRef.buyToken || '', // From providerRef if available
      sellAmount: providerRef.sellAmount || '', // From providerRef if available
      buyAmount: route.totalEstimatedOut,
      minBuyAmount:
        route.minOutputAmount ||
        providerRef.minBuyAmount ||
        route.totalEstimatedOut, // Use minOutputAmount if available
      gas: route.fees?.gas || '0',
      gasPrice: route.fees?.gasPrice || route.fees?.gas || '0', // Use actual gasPrice if available
      estimatedGas: route.fees?.gas || '0',
      maxFeePerGas:
        route.fees?.maxFeePerGas || providerRef.maxFeePerGas || undefined, // EIP-1559 max fee
      maxPriorityFeePerGas:
        route.fees?.maxPriorityFeePerGas ||
        providerRef.maxPriorityFeePerGas ||
        undefined, // EIP-1559 priority fee
      value: providerRef.value || '0',
      to: providerRef.to || '', // From providerRef if available
      data: providerRef.data || '', // From providerRef if available
      allowanceTarget:
        providerRef.allowanceTarget || providerRef.approvalAddress || '', // From providerRef if available
      aggregator: AggregatorType.ZEROX, // Default for compatibility
      priceImpact:
        route.priceImpact || providerRef.priceImpact?.toString() || undefined,
      // Note: slippage is available in providerRef if needed, but not part of SwapQuote interface
      approvalStrategy: ApprovalStrategy.ALLOWANCE_HOLDER, // Default
    };
  }

  /**
   * Get quote from specified aggregator (defaults to 0x for backward compatibility)
   * Enhanced version with dynamic provider selection based on chain support and health
   */
  async getQuote(
    request: SwapRequest,
    aggregatorType?: AggregatorType,
    strictValidation?: boolean,
  ): Promise<SwapQuote> {
    // If aggregatorType is specified, try to honor the preference but fallback intelligently
    if (aggregatorType) {
      const providerName = this.mapAggregatorTypeToProviderName(aggregatorType);

      try {
        // Try preferred provider first (with health monitoring)
        return await this.getEvmQuote(request, providerName);
      } catch (enhancedError) {
        this.winstonLogger.warn(
          `Preferred provider ${aggregatorType} failed, using dynamic selection: ${enhancedError.message}`,
        );

        // Fallback to dynamic selection if preferred provider fails
        return await this.getDynamicQuote(request, strictValidation);
      }
    }

    // No aggregator specified - use fully dynamic selection
    return await this.getDynamicQuote(request, strictValidation);
  }

  /**
   * Get price from specified aggregator (defaults to 0x for backward compatibility)
   * Enhanced version with dynamic provider selection
   */
  async getPrice(
    request: SwapRequest,
    aggregatorType?: AggregatorType,
    approvalStrategy?: ApprovalStrategy,
  ): Promise<any> {
    // If aggregatorType is specified, try to honor preference but fallback intelligently
    if (aggregatorType) {
      const providerName = this.mapAggregatorTypeToProviderName(aggregatorType);

      try {
        // Try preferred provider first
        const quote = await this.getEvmQuote(request, providerName);
        return this.convertQuoteToPrice(quote);
      } catch (enhancedError) {
        this.winstonLogger.warn(
          `Preferred provider ${aggregatorType} failed for price, using dynamic selection: ${enhancedError.message}`,
        );

        // Fallback to dynamic selection
        const quote = await this.getDynamicQuote(request);
        return this.convertQuoteToPrice(quote);
      }
    }

    // No aggregator specified - use fully dynamic selection
    const quote = await this.getDynamicQuote(request);
    return this.convertQuoteToPrice(quote);
  }

  /**
   * Dynamic quote selection - chooses best provider at runtime based on:
   * 1. Chain support
   * 2. Provider health
   * 3. Historical performance (latency)
   * 4. Provider-specific optimizations
   * Rubic is now tried as PRIMARY provider first, then EVM aggregators as fallback
   */
  private async getDynamicQuote(
    request: SwapRequest,
    strictValidation?: boolean,
  ): Promise<SwapQuote> {
    // RUBIC-FIRST STRATEGY: Try meta aggregators (Rubic) first for broader liquidity discovery
    const rubicProvider = this.metaAggregators.get('Rubic');
    if (
      rubicProvider &&
      typeof rubicProvider.supportsChain === 'function' &&
      rubicProvider.supportsChain(request.chainId)
    ) {
      try {
        this.winstonLogger.log(
          '🔄 Attempting Rubic (meta aggregator) as PRIMARY provider for on-chain swap',
        );
        const routeRequest: RouteRequest = {
          fromChainId: request.chainId,
          toChainId: request.chainId, // Same chain for on-chain swap
          fromToken: request.sellToken,
          toToken: request.buyToken,
          amount: request.sellAmount,
          userAddress: request.taker,
          recipient: request.recipient,
          slippageBps: request.slippagePercentage
            ? request.slippagePercentage * 100
            : 300, // Convert to basis points
        };
        const routes = await rubicProvider.getRoutes(routeRequest);
        if (routes.length > 0) {
          this.winstonLogger.log(
            '✅ Rubic provided on-chain route (PRIMARY provider)',
          );
          this.cacheRoutes('Rubic', routes);
          // Convert RouteQuote to SwapQuote format
          return this.convertRouteQuoteToSwapQuote(routes[0], 'Rubic');
        } else {
          this.winstonLogger.warn(
            'Rubic returned no routes, falling back to EVM aggregators',
          );
        }
      } catch (error) {
        this.winstonLogger.warn(
          `Rubic failed as primary provider: ${error.message}, trying EVM aggregators`,
        );
      }
    }

    // FALLBACK: Get EVM aggregators (0x, Odos) as secondary providers
    const supportedProviders = await this.getProvidersForChain(request.chainId);

    if (supportedProviders.length === 0) {
      this.winstonLogger.warn(
        `No EVM providers support chain ${request.chainId}`,
      );

      throw new Error(
        `No providers support chain ${request.chainId}. Supported chains: ${this.getAllSupportedChains().join(', ')}`,
      );
    }

    // Filter to only healthy providers
    const healthyProviders =
      await this.filterHealthyProviders(supportedProviders);

    if (healthyProviders.length === 0) {
      this.winstonLogger.warn(
        `No healthy providers for chain ${request.chainId}, attempting with all providers as fallback`,
      );
      // Fallback: try all providers even if health check failed
      return await this.tryProvidersWithFallback(
        supportedProviders,
        request,
        strictValidation,
      );
    }

    // Sort providers by performance and suitability
    const rankedProviders = await this.rankProvidersByPerformance(
      healthyProviders,
      request,
    );

    this.winstonLogger.debug(
      `Dynamic provider selection for chain ${request.chainId}: ${rankedProviders.map((p) => p.provider.getProviderName()).join(' > ')}`,
    );

    // Try providers in ranked order
    return await this.tryProvidersInOrder(
      rankedProviders.map((p) => p.provider),
      request,
      strictValidation,
    );
  }

  /**
   * Get all providers that support a specific chain
   * NOTE: For on-chain swaps only (uses getQuote)
   * Meta aggregators (Rubic, Symbiosis) use getRoutes() for cross-chain
   * and are handled separately in getDynamicQuote for on-chain via route conversion
   */
  private async getProvidersForChain(
    chainId: number,
  ): Promise<IOnchainAggregator[]> {
    const supportedProviders: IOnchainAggregator[] = [];

    // Only EVM aggregators support direct getQuote() calls for on-chain swaps
    // Meta aggregators are handled separately via getRoutes() -> SwapQuote conversion
    for (const provider of this.evmAggregators.values()) {
      if (
        typeof provider.supportsChain === 'function' &&
        provider.supportsChain(chainId)
      ) {
        supportedProviders.push(provider);
      }
    }

    return supportedProviders;
  }

  /**
   * Filter providers to only include healthy ones
   */
  private async filterHealthyProviders(
    providers: IOnchainAggregator[],
  ): Promise<IOnchainAggregator[]> {
    const healthyProviders: IOnchainAggregator[] = [];

    for (const provider of providers) {
      const health = await this.getProviderHealth(provider);
      if (health.status === 'healthy') {
        healthyProviders.push(provider);
      } else {
        this.winstonLogger.debug(
          `Provider ${provider.getProviderName()} is unhealthy: ${health.status}`,
        );
      }
    }

    return healthyProviders;
  }

  /**
   * Rank providers by performance and suitability for the request
   */
  private async rankProvidersByPerformance(
    providers: IOnchainAggregator[],
    request: SwapRequest,
  ): Promise<
    Array<{ provider: IOnchainAggregator; score: number; reason: string }>
  > {
    const ranked: Array<{
      provider: IOnchainAggregator;
      score: number;
      reason: string;
    }> = [];

    for (const provider of providers) {
      const score = await this.calculateProviderScore(provider, request);
      const reason = this.getProviderScoreReason(provider, request, score);
      ranked.push({ provider, score, reason });
    }

    // Sort by score (higher is better)
    ranked.sort((a, b) => b.score - a.score);

    // Log ranking for debugging
    ranked.forEach((item, index) => {
      this.winstonLogger.debug(
        `Rank ${index + 1}: ${item.provider.getProviderName()} (score: ${item.score}) - ${item.reason}`,
      );
    });

    return ranked;
  }

  /**
   * Calculate performance score for a provider
   */
  private async calculateProviderScore(
    provider: IOnchainAggregator,
    request: SwapRequest,
  ): Promise<number> {
    let score = 100; // Base score

    // Health bonus
    const health = await this.getProviderHealth(provider);
    if (health.status === 'healthy') {
      score += 50;

      // Latency bonus (lower latency = higher score)
      if (health.latency) {
        const latencyBonus = Math.max(0, 100 - health.latency); // 100ms = 0 bonus, 0ms = 100 bonus
        score += latencyBonus;
      }

      // Error rate penalty
      if (health.errorRate !== undefined) {
        const errorPenalty = health.errorRate * 100; // 0.1 error rate = 10 point penalty
        score -= errorPenalty;
      }
    } else {
      score -= 100; // Heavy penalty for unhealthy providers
    }

    // Provider-specific bonuses
    const providerName = provider.getProviderName().toLowerCase();

    // Chain-specific optimizations
    if (request.chainId === 1) {
      // Ethereum Mainnet
      if (providerName === '0x') score += 20; // 0x is typically well-optimized for Ethereum
    } else if (request.chainId === 137) {
      // Polygon
      if (providerName === 'odos') score += 15; // Odos might have better Polygon support
    }

    // Trade size considerations
    if (request.sellAmount) {
      const amount = parseFloat(request.sellAmount);
      if (amount > 1e21) {
        // Large trades (>1000 tokens assuming 18 decimals)
        if (providerName === '0x') score += 10; // 0x might handle large trades better
      }
    }

    return Math.max(0, score); // Ensure non-negative score
  }

  /**
   * Get human-readable reason for provider score
   */
  private getProviderScoreReason(
    provider: IOnchainAggregator,
    request: SwapRequest,
    score: number,
  ): string {
    const providerName = provider.getProviderName();
    const reasons: string[] = [];

    if (score >= 150) reasons.push('excellent health & performance');
    else if (score >= 120) reasons.push('good health & performance');
    else if (score >= 100) reasons.push('healthy');
    else if (score >= 50) reasons.push('degraded performance');
    else reasons.push('poor health');

    // Add specific reasons
    if (request.chainId === 1 && providerName.toLowerCase() === '0x') {
      reasons.push('optimized for Ethereum');
    }

    return reasons.join(', ');
  }

  /**
   * Try providers in order until one succeeds
   */
  private async tryProvidersInOrder(
    providers: IOnchainAggregator[],
    request: SwapRequest,
    strictValidation?: boolean,
  ): Promise<SwapQuote> {
    const portsRequest = this.convertToPortsRequest(request);
    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        this.winstonLogger.debug(
          `Attempting dynamic quote from ${provider.getProviderName()}`,
        );
        const start = Date.now();
        const quote = await provider.getQuote(portsRequest);
        this.providerHealth.recordSuccess(
          provider.getProviderName(),
          'quote',
          Date.now() - start,
        );
        const legacyQuote = this.convertToLegacyQuote(
          quote,
          provider.getProviderName(),
        );

        this.winstonLogger.log(
          `✅ Dynamic selection chose ${provider.getProviderName()} for chain ${request.chainId}`,
        );
        return legacyQuote;
      } catch (error) {
        this.providerHealth.recordFailure(
          provider.getProviderName(),
          'quote',
          undefined,
          error?.code || error?.name || 'error',
        );
        this.winstonLogger.warn(
          `❌ Provider ${provider.getProviderName()} failed: ${error.message}`,
        );
        lastError = error as Error;
        continue;
      }
    }

    throw new Error(
      `All providers failed for chain ${request.chainId}. Last error: ${lastError?.message}`,
    );
  }

  /**
   * Try providers with intelligent fallback (including unhealthy ones as last resort)
   * Rubic is used as the absolute final fallback
   */
  private async tryProvidersWithFallback(
    providers: IOnchainAggregator[],
    request: SwapRequest,
    strictValidation?: boolean,
  ): Promise<SwapQuote> {
    const portsRequest = this.convertToPortsRequest(request);
    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        this.winstonLogger.debug(
          `Attempting fallback quote from ${provider.getProviderName()}`,
        );
        const start = Date.now();
        const quote = await provider.getQuote(portsRequest);
        this.providerHealth.recordSuccess(
          provider.getProviderName(),
          'quote',
          Date.now() - start,
        );
        const legacyQuote = this.convertToLegacyQuote(
          quote,
          provider.getProviderName(),
        );

        this.winstonLogger.log(
          `✅ Fallback selection chose ${provider.getProviderName()} for chain ${request.chainId}`,
        );
        return legacyQuote;
      } catch (error) {
        this.providerHealth.recordFailure(
          provider.getProviderName(),
          'quote',
          undefined,
          error?.code || error?.name || 'error',
        );
        this.winstonLogger.warn(
          `❌ Fallback provider ${provider.getProviderName()} failed: ${error.message}`,
        );
        lastError = error as Error;
        continue;
      }
    }

    // All EVM providers failed, try Rubic as absolute final fallback
    this.winstonLogger.warn(
      'All EVM providers (including unhealthy) failed, trying Rubic as absolute final fallback',
    );
    const rubicProvider = this.metaAggregators.get('Rubic');
    if (rubicProvider) {
      try {
        this.winstonLogger.log(
          '🔄 Using Rubic as absolute final fallback for EVM swap',
        );
        const routeRequest: RouteRequest = {
          fromChainId: request.chainId,
          toChainId: request.chainId,
          fromToken: request.sellToken,
          toToken: request.buyToken,
          amount: request.sellAmount,
          userAddress: request.taker,
          recipient: request.recipient,
          slippageBps: request.slippagePercentage
            ? request.slippagePercentage * 100
            : 300,
        };
        const routes = await rubicProvider.getRoutes(routeRequest);
        if (routes.length > 0) {
          this.winstonLogger.log('✅ Rubic absolute final fallback succeeded');
          this.cacheRoutes('Rubic', routes);
          return this.convertRouteQuoteToSwapQuote(routes[0], 'Rubic');
        }
      } catch (error) {
        this.winstonLogger.error(
          `Rubic absolute final fallback also failed: ${error.message}`,
        );
      }
    }

    throw new Error(
      `All providers (including Rubic fallback) failed for chain ${request.chainId}. Last error: ${lastError?.message}`,
    );
  }

  /**
   * Get all supported chains across all providers
   */
  private getAllSupportedChains(): number[] {
    const chains = new Set<number>();

    for (const provider of this.evmAggregators.values()) {
      // Common chains to check (could be expanded)
      const commonChains = [
        1, 10, 56, 137, 42161, 43114, 8453, 324, 59144, 100, 250, 1284, 1285,
      ];
      commonChains.forEach((chainId) => {
        if (provider.supportsChain(chainId)) {
          chains.add(chainId);
        }
      });
    }

    return Array.from(chains).sort();
  }

  /**
   * Legacy quote method (original implementation)
   */
  private async getLegacyQuote(
    request: SwapRequest,
    aggregatorType: AggregatorType,
    strictValidation?: boolean,
  ): Promise<SwapQuote> {
    // Validate aggregator is supported
    if (!this.aggregators.has(aggregatorType)) {
      throw new Error(`Unsupported aggregator: ${aggregatorType}`);
    }

    this.winstonLogger.debug(
      `Getting legacy quote from ${aggregatorType} for chain ${request.chainId}${strictValidation === false ? ' (relaxed validation)' : ''}`,
    );
    return this.getQuoteFromAggregator(
      request,
      aggregatorType,
      strictValidation,
    );
  }

  /**
   * Legacy price method (original implementation)
   */
  private async getLegacyPrice(
    request: SwapRequest,
    aggregatorType: AggregatorType,
    approvalStrategy?: ApprovalStrategy,
  ): Promise<any> {
    // Validate aggregator is supported
    if (!this.aggregators.has(aggregatorType)) {
      throw new Error(`Unsupported aggregator: ${aggregatorType}`);
    }

    this.winstonLogger.debug(
      `Getting legacy price from ${aggregatorType} for chain ${request.chainId}`,
    );
    return this.getPriceFromAggregator(
      request,
      aggregatorType,
      approvalStrategy,
    );
  }

  /**
   * Map AggregatorType enum to provider name string
   */
  private mapAggregatorTypeToProviderName(
    aggregatorType: AggregatorType,
  ): string {
    switch (aggregatorType) {
      case AggregatorType.ZEROX:
        return '0x';
      case AggregatorType.ODOS:
        return 'odos';
      default:
        return '0x'; // Default fallback
    }
  }

  /**
   * Convert SwapQuote to price-like response
   */
  private convertQuoteToPrice(quote: SwapQuote): any {
    return {
      sellToken: quote.sellToken,
      buyToken: quote.buyToken,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      price:
        quote.buyAmount && quote.sellAmount
          ? (
              parseFloat(quote.buyAmount) / parseFloat(quote.sellAmount)
            ).toString()
          : '0',
      priceImpact: quote.priceImpact,
      sources: [], // Could be populated from aggregator data
      allowanceTarget: quote.allowanceTarget,
      aggregator: quote.aggregator,
      approvalStrategy: quote.approvalStrategy,
    };
  }

  /**
   * Get quote from specific aggregator
   */
  private async getQuoteFromAggregator(
    request: SwapRequest,
    aggregatorType: AggregatorType,
    strictValidation?: boolean,
  ): Promise<SwapQuote> {
    const aggregator = this.aggregators.get(aggregatorType);
    if (!aggregator) {
      throw new Error(`Unsupported aggregator: ${aggregatorType}`);
    }

    if (!aggregator.supportsChain(request.chainId)) {
      throw new Error(
        `Aggregator ${aggregatorType} does not support chain ${request.chainId}`,
      );
    }

    // Use standard getQuote method with strictValidation for all aggregators
    return aggregator.getQuote(request, strictValidation);
  }

  /**
   * Get price from specific aggregator
   */
  private async getPriceFromAggregator(
    request: SwapRequest,
    aggregatorType: AggregatorType,
    approvalStrategy?: ApprovalStrategy,
  ): Promise<any> {
    const aggregator = this.aggregators.get(aggregatorType);
    if (!aggregator) {
      throw new Error(`Unsupported aggregator: ${aggregatorType}`);
    }

    if (!aggregator.supportsChain(request.chainId)) {
      throw new Error(
        `Aggregator ${aggregatorType} does not support chain ${request.chainId}`,
      );
    }

    // Use standard getPrice/getQuote methods for all aggregators
    if (aggregatorType === AggregatorType.ZEROX) {
      return aggregator.getPrice(request);
    } else {
      // For other aggregators, return quote data as price (no separate price endpoint)
      return aggregator.getQuote(request);
    }
  }

  /**
   * Get spender address for specified aggregator (defaults to 0x)
   */
  async getSpenderAddress(
    chainId: number,
    aggregatorType?: AggregatorType,
  ): Promise<string> {
    const selectedAggregator = aggregatorType || AggregatorType.ZEROX;

    if (!this.aggregators.has(selectedAggregator)) {
      throw new Error(`Unsupported aggregator: ${selectedAggregator}`);
    }

    const aggregator = this.aggregators.get(selectedAggregator);
    if (!aggregator) {
      throw new Error(`${selectedAggregator} service not available`);
    }

    if (!aggregator.supportsChain(chainId)) {
      throw new Error(
        `${selectedAggregator} does not support chain ${chainId}`,
      );
    }

    // Only 0x Protocol has getSpenderAddress method
    if (
      selectedAggregator === AggregatorType.ZEROX &&
      aggregator.getSpenderAddress
    ) {
      return aggregator.getSpenderAddress(chainId);
    }

    // For other aggregators, spender is typically the router address
    throw new Error(
      `Spender address not available for ${selectedAggregator}. Use router address from quote.`,
    );
  }

  /**
   * Get token list from specified aggregator (defaults to 0x)
   */
  async getTokenList(
    chainId: number,
    aggregatorType?: AggregatorType,
  ): Promise<any[]> {
    const selectedAggregator = aggregatorType || AggregatorType.ZEROX;

    if (!this.aggregators.has(selectedAggregator)) {
      throw new Error(`Unsupported aggregator: ${selectedAggregator}`);
    }

    const aggregator = this.aggregators.get(selectedAggregator);
    if (!aggregator) {
      throw new Error(`${selectedAggregator} service not available`);
    }

    if (!aggregator.supportsChain(chainId)) {
      throw new Error(
        `${selectedAggregator} does not support chain ${chainId}`,
      );
    }

    // Only 0x Protocol has getTokenList method
    if (
      selectedAggregator === AggregatorType.ZEROX &&
      aggregator.getTokenList
    ) {
      return aggregator.getTokenList(chainId);
    }

    // For other aggregators, return empty array or fetch from external source
    return [];
  }

  /**
   * Get supported aggregators for a chain
   */
  getSupportedAggregators(chainId: number): AggregatorType[] {
    const supported: AggregatorType[] = [];

    for (const [aggregatorType, aggregator] of this.aggregators) {
      if (aggregator && aggregator.supportsChain(chainId)) {
        supported.push(aggregatorType);
        this.winstonLogger.debug(
          `Aggregator ${aggregatorType} is supported for chain ${chainId}`,
        );
      }
    }

    return supported;
  }

  /**
   * Check if aggregator supports a chain
   */
  isAggregatorSupported(
    chainId: number,
    aggregatorType: AggregatorType,
  ): boolean {
    const aggregator = this.aggregators.get(aggregatorType);
    return aggregator ? aggregator.supportsChain(chainId) : false;
  }

  /**
   * Get all registered aggregators
   */
  getAllAggregators() {
    return Array.from(this.aggregators.values());
  }

  // ============================================================================
  // ENHANCED PROVIDER METHODS
  // ============================================================================

  /**
   * Get EVM swap quote using dynamic provider selection
   * If no preferred provider specified, uses intelligent runtime selection
   */
  async getEvmQuote(
    request: SwapRequest,
    preferredProvider?: string,
  ): Promise<SwapQuote> {
    // If preferred provider is specified, try it first but fallback to dynamic selection
    if (preferredProvider) {
      const providers = await this.getHealthyEvmProviders(request.chainId);
      const preferredProviderInstance = providers.find(
        (p) => p.getProviderName() === preferredProvider,
      );

      if (preferredProviderInstance) {
        try {
          const portsRequest = this.convertToPortsRequest(request);
          const quote = await preferredProviderInstance.getQuote(portsRequest);
          this.winstonLogger.log(
            `✅ Preferred provider ${preferredProvider} succeeded for chain ${request.chainId}`,
          );
          return this.convertToLegacyQuote(quote, preferredProvider);
        } catch (error) {
          this.winstonLogger.warn(
            `❌ Preferred provider ${preferredProvider} failed, falling back to dynamic selection: ${error.message}`,
          );
          // Continue to dynamic selection below
        }
      } else {
        this.winstonLogger.warn(
          `⚠️ Preferred provider ${preferredProvider} not available or unhealthy for chain ${request.chainId}, using dynamic selection`,
        );
      }
    }

    // Dynamic provider selection - no hardcoded preferences
    return await this.getDynamicQuote(request);
  }

  /**
   * Get cross-chain routes using meta aggregators
   * RUBIC IS PRIMARY: Prioritized for all cross-chain swaps (70+ chains, 360+ DEXs/bridges)
   * Supports EVM-EVM, EVM-L2, EVM-L1, L1-L2, and cross-chain swaps
   */
  async getCrossChainRoutes(
    request: RouteRequest,
    preferredProvider?: string,
  ): Promise<RouteQuote[]> {
    const providers = await this.getHealthyMetaProviders();

    if (providers.length === 0) {
      throw new Error('No healthy meta aggregators available');
    }

    // Prioritize Rubic for all cross-chain swaps if no preference specified
    // Rubic supports more chains and routes than other aggregators
    const rubicProvider = providers.find(
      (p) => p.getProviderName().toLowerCase() === 'rubic',
    );
    const effectivePreferredProvider =
      preferredProvider || (rubicProvider ? 'rubic' : undefined);

    // Use preferred provider if specified and healthy (or default to Rubic)
    if (
      effectivePreferredProvider &&
      providers.some(
        (p) =>
          p.getProviderName().toLowerCase() ===
          effectivePreferredProvider.toLowerCase(),
      )
    ) {
      const provider = providers.find(
        (p) =>
          p.getProviderName().toLowerCase() ===
          effectivePreferredProvider.toLowerCase(),
      )!;
      const isDefaultRubic =
        !preferredProvider &&
        provider.getProviderName().toLowerCase() === 'rubic';
      this.winstonLogger.log(
        `Using ${isDefaultRubic ? 'PRIMARY (default)' : 'preferred'} meta aggregator: ${provider.getProviderName()}`,
      );

      try {
        const start = Date.now();
        const routes = await provider.getRoutes(request);
        this.providerHealth.recordSuccess(
          provider.getProviderName(),
          'routes',
          Date.now() - start,
        );
        // Cache providerRef by routeId for later execution
        this.cacheRoutes(provider.getProviderName(), routes);

        if (routes.length > 0) {
          this.winstonLogger.log(
            `✅ ${provider.getProviderName()} provided ${routes.length} route(s)`,
          );
          return routes;
        }

        this.winstonLogger.warn(
          `⚠️ ${provider.getProviderName()} returned no routes, trying other providers`,
        );
      } catch (error) {
        this.providerHealth.recordFailure(
          provider.getProviderName(),
          'routes',
          undefined,
          error?.code || error?.name || 'error',
        );
        this.winstonLogger.warn(
          `❌ ${provider.getProviderName()} failed: ${error.message}, trying other providers`,
        );
      }
    }

    // Fallback: Aggregate routes from all providers
    const allRoutes: RouteQuote[] = [];
    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        this.winstonLogger.debug(
          `Fetching routes from meta aggregator: ${provider.getProviderName()}`,
        );
        const start = Date.now();
        const routes = await provider.getRoutes(request);
        this.providerHealth.recordSuccess(
          provider.getProviderName(),
          'routes',
          Date.now() - start,
        );
        // Cache providerRef by routeId for later execution
        this.cacheRoutes(provider.getProviderName(), routes);
        return routes;
      }),
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allRoutes.push(...result.value);
        this.winstonLogger.log(
          `✅ ${providers[index].getProviderName()} provided ${result.value.length} routes`,
        );
      } else {
        this.providerHealth.recordFailure(
          providers[index].getProviderName(),
          'routes',
          undefined,
          (result as any)?.reason?.code ||
            (result as any)?.reason?.name ||
            'error',
        );
        this.winstonLogger.warn(
          `❌ Meta aggregator ${providers[index].getProviderName()} failed: ${result.reason.message}`,
        );
      }
    });

    if (allRoutes.length === 0) {
      throw new Error('All meta aggregators failed to provide routes');
    }

    this.winstonLogger.log(
      `✅ Aggregated ${allRoutes.length} total routes from ${providers.length} meta aggregators`,
    );

    // Sort by confidence and estimated output (Rubic routes typically have good confidence scores)
    return allRoutes.sort((a, b) => {
      const confidenceDiff = (b.confidence || 0) - (a.confidence || 0);
      if (Math.abs(confidenceDiff) > 0.1) return confidenceDiff;

      return parseFloat(b.totalEstimatedOut) - parseFloat(a.totalEstimatedOut);
    });
  }

  /**
   * Execute a cached cross-chain route using the appropriate meta aggregator
   */
  async executeCrossChain(
    routeId: string,
    signerCtx: any,
  ): Promise<{ txids: string[] }> {
    if (!routeId) throw new Error('routeId is required');

    const cached = this.crossChainRouteCache.get(routeId);
    if (!cached) {
      throw new Error(
        'ROUTE_NOT_FOUND_OR_EXPIRED: Route details not found in cache. Please re-request routes and try again.',
      );
    }
    if (Date.now() > cached.expiresAt) {
      this.crossChainRouteCache.delete(routeId);
      throw new Error(
        'ROUTE_NOT_FOUND_OR_EXPIRED: Cached route expired. Please re-request routes and try again.',
      );
    }

    const provider = this.metaAggregators.get(cached.providerName);
    if (!provider) {
      throw new Error(`Meta aggregator '${cached.providerName}' not available`);
    }

    // Attach providerRef for execution context
    const execCtx = { ...signerCtx, providerRef: cached.providerRef };
    this.winstonLogger.debug(
      `Executing cross-chain route ${routeId} via ${cached.providerName}`,
    );
    const start = Date.now();
    try {
      const result = await provider.execute(routeId, execCtx);
      this.providerHealth.recordSuccess(
        cached.providerName,
        'execute',
        Date.now() - start,
      );
      return result;
    } catch (error) {
      this.providerHealth.recordFailure(
        cached.providerName,
        'execute',
        Date.now() - start,
        error?.code || error?.name || 'error',
      );
      throw error;
    }
  }

  /**
   * Cache helper for routes returned from providers
   */
  private cacheRoutes(providerName: string, routes: RouteQuote[] = []): void {
    const now = Date.now();
    for (const route of routes) {
      if (!route?.routeId || !route?.providerRef) continue;
      this.crossChainRouteCache.set(route.routeId, {
        providerName,
        providerRef: route.providerRef,
        expiresAt: now + this.crossChainRouteCacheTtlMs,
      });
    }
  }

  /**
   * Get Solana swap quote
   * Rubic is used as a fallback if primary Solana providers fail
   */
  async getSolanaQuote(
    request: any,
    preferredProvider?: string,
  ): Promise<RouteQuote> {
    const providers = await this.getHealthySolanaProviders();

    if (providers.length === 0) {
      this.winstonLogger.warn(
        'No healthy Solana routers available, trying Rubic as fallback',
      );

      // Try Rubic as fallback for Solana swaps
      const rubicProvider = this.metaAggregators.get('Rubic');
      if (rubicProvider) {
        try {
          this.winstonLogger.log('🔄 Using Rubic as fallback for Solana swap');
          // Rubic can handle Solana swaps through its cross-chain capabilities
          const routeRequest: RouteRequest = {
            fromChainId: request.fromChainId || 'solana-mainnet', // Use string format for consistency
            toChainId: request.toChainId || 'solana-mainnet',
            fromToken: request.fromMint,
            toToken: request.toMint,
            amount: request.amount,
            userAddress: request.userPublicKey,
            slippageBps: request.slippageBps,
          };
          const routes = await rubicProvider.getRoutes(routeRequest);
          if (routes.length > 0) {
            this.winstonLogger.log(
              '✅ Rubic provided fallback route for Solana swap',
            );
            this.cacheRoutes('Rubic', routes);
            return routes[0];
          }
        } catch (error) {
          this.winstonLogger.error(
            `Rubic fallback failed for Solana: ${error.message}`,
          );
        }
      }

      throw new Error('No Solana routers available');
    }

    // Use preferred provider if specified and healthy
    if (
      preferredProvider &&
      providers.some(
        (p) =>
          p.getProviderName().toLowerCase() === preferredProvider.toLowerCase(),
      )
    ) {
      const provider = providers.find(
        (p) =>
          p.getProviderName().toLowerCase() === preferredProvider.toLowerCase(),
      );
      try {
        this.winstonLogger.debug(
          `Using preferred Solana provider: ${provider!.getProviderName()}`,
        );
        const start = Date.now();
        const result = await provider!.quote(request);
        this.providerHealth.recordSuccess(
          provider!.getProviderName(),
          'quote',
          Date.now() - start,
        );
        return result;
      } catch (error) {
        this.providerHealth.recordFailure(
          provider!.getProviderName(),
          'quote',
          undefined,
          error?.code || error?.name || 'error',
        );
        this.winstonLogger.warn(
          `Preferred Solana provider failed: ${error.message}, trying fallbacks`,
        );
      }
    }

    // Try providers in order
    let lastError: Error | null = null;
    for (const provider of providers) {
      try {
        this.winstonLogger.debug(
          `Attempting Solana quote from ${provider.getProviderName()}`,
        );
        const start = Date.now();
        const result = await provider.quote(request);
        this.providerHealth.recordSuccess(
          provider.getProviderName(),
          'quote',
          Date.now() - start,
        );
        return result;
      } catch (error) {
        this.providerHealth.recordFailure(
          provider.getProviderName(),
          'quote',
          undefined,
          error?.code || error?.name || 'error',
        );
        this.winstonLogger.warn(
          `Solana provider ${provider.getProviderName()} failed: ${error.message}`,
        );
        lastError = error as Error;
        continue;
      }
    }

    // All Solana providers failed, try Rubic as final fallback
    this.winstonLogger.warn(
      'All Solana providers failed, trying Rubic as final fallback',
    );
    const rubicProvider = this.metaAggregators.get('Rubic');
    if (rubicProvider) {
      try {
        this.winstonLogger.log(
          '🔄 Using Rubic as final fallback for Solana swap',
        );
        const routeRequest: RouteRequest = {
          fromChainId: request.fromChainId || 'solana-mainnet', // Use string format for consistency
          toChainId: request.toChainId || 'solana-mainnet',
          fromToken: request.fromMint,
          toToken: request.toMint,
          amount: request.amount,
          userAddress: request.userPublicKey,
          slippageBps: request.slippageBps,
        };
        const routes = await rubicProvider.getRoutes(routeRequest);
        if (routes.length > 0) {
          this.winstonLogger.log(
            '✅ Rubic final fallback succeeded for Solana swap',
          );
          this.cacheRoutes('Rubic', routes);
          return routes[0];
        }
      } catch (error) {
        this.winstonLogger.error(
          `Rubic final fallback also failed: ${error.message}`,
        );
      }
    }

    throw new Error(
      `All Solana routers (including Rubic fallback) failed. Last error: ${lastError?.message}`,
    );
  }

  /**
   * Build transaction for EVM swap
   */
  async buildEvmTransaction(
    request: SwapRequest,
    preferredProvider?: string,
  ): Promise<TransactionBuild> {
    const providers = await this.getHealthyEvmProviders(request.chainId);

    if (providers.length === 0) {
      throw new Error(
        `No healthy EVM aggregators available for chain ${request.chainId}`,
      );
    }

    const provider = preferredProvider
      ? providers.find((p) => p.getProviderName() === preferredProvider) ||
        providers[0]
      : providers[0];

    const portsRequest = this.convertToPortsRequest(request);
    const start = Date.now();
    try {
      const tx = await provider.buildTx(portsRequest);
      this.providerHealth.recordSuccess(
        provider.getProviderName(),
        'buildTx',
        Date.now() - start,
      );
      return tx;
    } catch (error) {
      this.providerHealth.recordFailure(
        provider.getProviderName(),
        'buildTx',
        Date.now() - start,
        error?.code || error?.name || 'error',
      );
      throw error;
    }
  }

  /**
   * Get enhanced spender address for approvals (supports strategy-specific addresses)
   */
  async getEnhancedSpenderAddress(
    chainId: number,
    strategy: ApprovalStrategy = ApprovalStrategy.ALLOWANCE_HOLDER,
    providerName?: string,
  ): Promise<string> {
    const providers = await this.getHealthyEvmProviders(chainId);

    if (providers.length === 0) {
      throw new Error(
        `No healthy EVM aggregators available for chain ${chainId}`,
      );
    }

    // Prioritize 0x for strategy-specific spender addresses
    const zeroXProvider = providers.find((p) => p.getProviderName() === '0x');
    if (zeroXProvider && 'getSpenderAddress' in zeroXProvider) {
      return (zeroXProvider as any).getSpenderAddress(chainId, strategy);
    }

    // Fallback to other providers
    const provider = providerName
      ? providers.find((p) => p.getProviderName() === providerName) ||
        providers[0]
      : providers[0];

    if ('getSpenderAddress' in provider) {
      return (provider as any).getSpenderAddress(chainId);
    }

    throw new Error('No provider supports spender address retrieval');
  }

  /**
   * Enhanced multiple quotes from different aggregators with dynamic provider selection
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
    const startTime = Date.now();

    const request: SwapRequest = {
      chainId,
      sellToken,
      buyToken,
      sellAmount,
      taker,
      recipient,
      slippagePercentage,
      deadline,
    };

    this.winstonLogger.audit('QUOTES_REQUEST', {
      chainId,
      sellToken,
      buyToken,
      sellAmount,
      taker,
      timestamp: new Date().toISOString(),
    });

    // Get all providers that support this chain (not just healthy ones for comparison)
    const supportedProviders = await this.getProvidersForChain(chainId);

    if (supportedProviders.length === 0) {
      throw new Error(
        `No providers support chain ${chainId}. Supported chains: ${this.getAllSupportedChains().join(', ')}`,
      );
    }

    this.winstonLogger.debug(
      `Getting multiple quotes from ${supportedProviders.length} providers for chain ${chainId}: ${supportedProviders.map((p) => p.getProviderName()).join(', ')}`,
    );

    const results: Array<{ aggregator: AggregatorType; quote: SwapQuote }> = [];
    const portsRequest = this.convertToPortsRequest(request);

    // Try each provider in parallel
    const quotes = await Promise.allSettled(
      supportedProviders.map(async (provider) => {
        try {
          const start = Date.now();
          const quote = await provider.getQuote(portsRequest, false);
          this.providerHealth.recordSuccess(
            provider.getProviderName(),
            'quote',
            Date.now() - start,
          );
          const legacyQuote = this.convertToLegacyQuote(
            quote,
            provider.getProviderName(),
          );
          return {
            aggregator: legacyQuote.aggregator,
            quote: legacyQuote,
          };
        } catch (error) {
          this.providerHealth.recordFailure(
            provider.getProviderName(),
            'quote',
            undefined,
            error?.code || error?.name || 'error',
          );
          this.winstonLogger.warn(
            `Provider ${provider.getProviderName()} failed for multiple quotes: ${error.message}`,
          );
          throw error;
        }
      }),
    );

    quotes.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        this.winstonLogger.debug(
          `✅ ${supportedProviders[index].getProviderName()} provided quote: ${result.value.quote.buyAmount} tokens`,
        );
      } else {
        this.winstonLogger.warn(
          `❌ ${supportedProviders[index].getProviderName()} failed: ${result.reason.message}`,
        );
      }
    });

    if (results.length === 0) {
      throw new Error(
        `All ${supportedProviders.length} providers failed to provide quotes for chain ${chainId}`,
      );
    }

    const duration = Date.now() - startTime;

    this.winstonLogger.audit('QUOTES_RESPONSE', {
      chainId,
      totalRequested: supportedProviders.length,
      successful: results.length,
      failed: supportedProviders.length - results.length,
      aggregators: results.map((r) => r.aggregator),
      duration,
      timestamp: new Date().toISOString(),
    });

    this.winstonLogger.log(
      `✅ Got ${results.length}/${supportedProviders.length} quotes for chain ${chainId}`,
    );
    return results;
  }

  /**
   * Enhanced best quote selection with health monitoring
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
    const multipleQuotes = await this.getMultipleQuotes(
      chainId,
      sellToken,
      buyToken,
      sellAmount,
      taker,
      recipient,
      slippagePercentage,
      deadline,
    );

    // Find the quote with the highest buyAmount
    const bestQuote = multipleQuotes.reduce((best, current) => {
      const bestBuyAmount = parseFloat(best.quote.buyAmount);
      const currentBuyAmount = parseFloat(current.quote.buyAmount);
      return currentBuyAmount > bestBuyAmount ? current : best;
    });

    return bestQuote;
  }

  /**
   * Enhanced quote comparison with health monitoring
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

    // Find best and calculate price difference
    const bestQuote = quotes.reduce((best, current) => {
      const bestBuyAmount = parseFloat(best.quote.buyAmount);
      const currentBuyAmount = parseFloat(current.quote.buyAmount);
      return currentBuyAmount > bestBuyAmount ? current : best;
    });

    const worstQuote = quotes.reduce((worst, current) => {
      const worstBuyAmount = parseFloat(worst.quote.buyAmount);
      const currentBuyAmount = parseFloat(current.quote.buyAmount);
      return currentBuyAmount < worstBuyAmount ? current : worst;
    });

    const bestAmount = parseFloat(bestQuote.quote.buyAmount);
    const worstAmount = parseFloat(worstQuote.quote.buyAmount);
    const priceDifference = (
      ((bestAmount - worstAmount) / worstAmount) *
      100
    ).toFixed(2);

    return {
      quotes,
      bestAggregator: bestQuote.aggregator,
      priceDifference: `${priceDifference}%`,
    };
  }

  /**
   * Enhanced supported aggregators with dynamic chain-based discovery
   * Returns all providers (EVM, Meta, Solana) that support the given chain
   * Supports both numeric chainIds (EVM: 1, 137) and string chainIds (Bitcoin: "bitcoin-mainnet")
   *
   * Uses each provider's own getSupportedChains() method for dynamic chain detection
   */
  async getEnhancedSupportedAggregators(
    chainId: number | string,
  ): Promise<AggregatorType[]> {
    const supported: AggregatorType[] = [];

    this.winstonLogger.debug(
      `Discovering supported aggregators for chain ${chainId}...`,
    );

    // 1. Check EVM aggregators (on-chain swaps) - only for numeric chainIds
    // Each provider's getSupportedChains() fetches from their API with caching
    if (typeof chainId === 'number') {
      for (const [providerName, provider] of this.evmAggregators) {
        if (provider) {
          try {
            // Use provider's own getSupportedChains method (already has API + fallback logic)
            const supportedChains = await provider.getSupportedChains();
            const isSupported = supportedChains.includes(chainId);

            if (isSupported) {
              const aggregatorType =
                this.mapProviderNameToAggregatorType(providerName);
              if (aggregatorType && !supported.includes(aggregatorType)) {
                supported.push(aggregatorType);
                this.winstonLogger.debug(
                  `✅ EVM aggregator: ${aggregatorType} (${providerName}) supports chain ${chainId}`,
                );
              }
            } else {
              this.winstonLogger.debug(
                `❌ ${providerName} does not support chain ${chainId}`,
              );
            }
          } catch (error) {
            this.winstonLogger.warn(
              `Failed to get supported chains from ${providerName}: ${error.message}`,
            );
          }
        }
      }
    } else {
      this.winstonLogger.debug(
        `⏭️  Skipping EVM aggregators for non-numeric chainId: ${chainId}`,
      );
    }

    // 2. Check Meta aggregators (cross-chain capable)
    // Each provider's getSupportedChains() returns cached chain pairs
    for (const [providerName, provider] of this.metaAggregators) {
      if (provider) {
        // For numeric chainIds, check via provider's getSupportedChains method
        if (typeof chainId === 'number') {
          try {
            const chainSupport = provider.getSupportedChains();
            const isSupported =
              chainSupport.from.includes(chainId) ||
              chainSupport.to.includes(chainId);

            if (isSupported) {
              const aggregatorType =
                this.mapProviderNameToAggregatorType(providerName);
              if (aggregatorType && !supported.includes(aggregatorType)) {
                supported.push(aggregatorType);
                this.winstonLogger.debug(
                  `✅ Meta aggregator: ${aggregatorType} (${providerName}) supports chain ${chainId}`,
                );
              }
            }
          } catch (error) {
            this.winstonLogger.warn(
              `Failed to get supported chains from ${providerName}: ${error.message}`,
            );
          }
        } else {
          // String chainIds typically not supported by meta aggregators (they focus on EVM/Solana)
          this.winstonLogger.debug(
            `⏭️  Meta aggregator ${providerName} skipped for native L1 chainId: ${chainId}`,
          );
        }
      }
    }

    // 4. Check Solana routers
    // Use unified configuration to determine if chainId is Solana
    if (typeof chainId === 'string') {
      const chainConfig =
        this.unifiedConfigService.getChainConfiguration(chainId);

      if (chainConfig && chainConfig.ecosystem === BlockchainEcosystem.SOLANA) {
        // Check if the chain has Solana routers in its supportedAggregators list
        const supportedAggregators = chainConfig.supportedAggregators || [];

        for (const [providerName, provider] of this.solanaRouters) {
          if (provider) {
            // Check if this Solana router is in the chain's supportedAggregators list
            const providerNameLower = providerName.toLowerCase();
            const isSupported = supportedAggregators.some(
              (agg) => agg.toLowerCase() === providerNameLower,
            );

            if (isSupported) {
              const aggregatorType =
                this.mapProviderNameToAggregatorType(providerName);
              if (aggregatorType && !supported.includes(aggregatorType)) {
                supported.push(aggregatorType);
                this.winstonLogger.debug(
                  `✅ Solana router: ${aggregatorType} (${providerName}) supports Solana`,
                );
              }
            }
          }
        }
      }
    }

    // If no providers found in enhanced registry, check legacy (should not happen after merge)
    if (supported.length === 0 && typeof chainId === 'number') {
      this.winstonLogger.warn(
        `No enhanced providers found for chain ${chainId}, checking legacy registry...`,
      );
      for (const [aggregatorType, aggregator] of this.aggregators) {
        if (aggregator && aggregator.supportsChain(chainId)) {
          supported.push(aggregatorType);
          this.winstonLogger.debug(
            `✅ Legacy fallback: ${aggregatorType} supports chain ${chainId}`,
          );
        }
      }
    }

    if (supported.length === 0) {
      this.winstonLogger.warn(
        `No aggregators support chain ${chainId}. This might be an unsupported chain.`,
      );
    } else {
      this.winstonLogger.log(
        `Found ${supported.length} aggregators for chain ${chainId}: ${supported.join(', ')}`,
      );
    }

    return supported;
  }

  /**
   * Get runtime provider recommendations for a specific request
   */
  async getProviderRecommendations(request: SwapRequest): Promise<
    Array<{
      provider: string;
      score: number;
      reason: string;
      supported: boolean;
      healthy: boolean;
    }>
  > {
    const recommendations: Array<{
      provider: string;
      score: number;
      reason: string;
      supported: boolean;
      healthy: boolean;
    }> = [];

    for (const [providerName, provider] of this.evmAggregators) {
      const supported = provider.supportsChain(request.chainId);
      let healthy = false;
      let score = 0;
      let reason = '';

      if (supported) {
        const health = await this.getProviderHealth(provider);
        healthy = health.status === 'healthy';

        if (healthy) {
          score = await this.calculateProviderScore(provider, request);
          reason = this.getProviderScoreReason(provider, request, score);
        } else {
          reason = `unhealthy: ${health.status}`;
        }
      } else {
        reason = `does not support chain ${request.chainId}`;
      }

      recommendations.push({
        provider: providerName,
        score,
        reason,
        supported,
        healthy,
      });
    }

    // Sort by score (highest first)
    recommendations.sort((a, b) => b.score - a.score);

    return recommendations;
  }

  /**
   * Map provider name to AggregatorType enum
   */
  private mapProviderNameToAggregatorType(
    providerName: string,
  ): AggregatorType | null {
    switch (providerName.toLowerCase()) {
      // EVM Aggregators
      case '0x':
        return AggregatorType.ZEROX;
      case 'odos':
        return AggregatorType.ODOS;

      // Meta Aggregators
      case 'socket':
        return AggregatorType.SOCKET;
      case 'rango':
        return AggregatorType.RANGO;
      case 'router':
      case 'router protocol':
        return AggregatorType.ROUTER;
      case 'rubic':
        return AggregatorType.RUBIC;

      // Native L1 Routers
      case 'thorchain':
      case 'thor':
        return AggregatorType.THORCHAIN;
      case 'maya':
      case 'maya protocol':
        return AggregatorType.MAYA;

      // Solana Routers
      case 'jupiter':
        return AggregatorType.JUPITER;
      case 'orca':
        return AggregatorType.ORCA;

      default:
        this.winstonLogger.debug(
          `⚠️ No AggregatorType mapping for provider: ${providerName}`,
        );
        return null;
    }
  }

  /**
   * Get comprehensive health status of all providers
   */
  async getProvidersHealth(): Promise<Record<string, ProviderHealth[]>> {
    const health: Record<string, ProviderHealth[]> = {
      evm: [],
      meta: [],
      solana: [],
    };

    // Check EVM providers
    for (const provider of this.evmAggregators.values()) {
      health.evm.push(await this.getProviderHealth(provider));
    }

    // Check meta providers
    for (const provider of this.metaAggregators.values()) {
      health.meta.push(await this.getProviderHealth(provider));
    }

    // Check Solana providers
    for (const provider of this.solanaRouters.values()) {
      health.solana.push(await this.getProviderHealth(provider));
    }

    return health;
  }

  /**
   * Get supported chains for EVM aggregators
   */
  getSupportedChains(): number[] {
    const chains = new Set<number>();

    for (const provider of this.evmAggregators.values()) {
      // Common chains to check
      const commonChains = [1, 10, 56, 137, 42161, 43114, 8453, 324, 59144];
      commonChains.forEach((chainId) => {
        if (provider.supportsChain(chainId)) {
          chains.add(chainId);
        }
      });
    }

    return Array.from(chains).sort();
  }

  /**
   * Get provider configurations
   */
  getProviderConfigs(): Record<string, any> {
    const configs: Record<string, any> = {};

    for (const provider of this.evmAggregators.values()) {
      configs[`evm_${provider.getProviderName()}`] = provider.getConfig();
    }

    for (const provider of this.metaAggregators.values()) {
      configs[`meta_${provider.getProviderName()}`] = provider.getConfig();
    }

    for (const provider of this.solanaRouters.values()) {
      configs[`solana_${provider.getProviderName()}`] = provider.getConfig();
    }

    return configs;
  }

  // ============================================================================
  // ENHANCED PROVIDER HEALTH MANAGEMENT
  // ============================================================================

  /**
   * Get healthy EVM providers for a specific chain
   * NOTE: Only returns EVM aggregators that support getQuote()
   * Meta aggregators are handled separately via getRoutes() for cross-chain
   */
  private async getHealthyEvmProviders(
    chainId: number,
  ): Promise<IOnchainAggregator[]> {
    const healthyProviders: IOnchainAggregator[] = [];

    // Only EVM aggregators use getQuote() for on-chain swaps
    for (const provider of this.evmAggregators.values()) {
      if (
        typeof provider.supportsChain === 'function' &&
        provider.supportsChain(chainId)
      ) {
        const health = await this.getProviderHealth(provider);
        if (health.status === 'healthy') {
          healthyProviders.push(provider);
        }
      }
    }

    // Sort by latency (ascending)
    return healthyProviders.sort((a, b) => {
      const healthA = this.healthCache.get(a.getProviderName());
      const healthB = this.healthCache.get(b.getProviderName());
      return (healthA?.latency || 1000) - (healthB?.latency || 1000);
    });
  }

  /**
   * Get healthy meta aggregators
   */
  private async getHealthyMetaProviders(): Promise<IMetaAggregator[]> {
    const healthyProviders: IMetaAggregator[] = [];

    for (const provider of this.metaAggregators.values()) {
      const health = await this.getProviderHealth(provider);
      if (health.status === 'healthy') {
        healthyProviders.push(provider);
      }
    }

    return healthyProviders;
  }

  /**
   * Get healthy Solana routers
   */
  private async getHealthySolanaProviders(): Promise<ISolanaRouter[]> {
    const healthyProviders: ISolanaRouter[] = [];

    for (const provider of this.solanaRouters.values()) {
      const health = await this.getProviderHealth(provider);
      if (health.status === 'healthy') {
        healthyProviders.push(provider);
      }
    }

    return healthyProviders;
  }

  /**
   * Get provider health with caching
   */
  private async getProviderHealth(
    provider: IProvider,
  ): Promise<ProviderHealth> {
    const name = provider.getProviderName();
    const cached = this.healthCache.get(name);

    if (
      cached &&
      Date.now() - cached.lastCheck.getTime() < this.healthCacheTimeout
    ) {
      return cached;
    }

    try {
      const health = await provider.healthCheck();
      this.healthCache.set(name, health);
      return health;
    } catch (error) {
      const failedHealth: ProviderHealth = {
        name,
        status: 'unhealthy',
        lastCheck: new Date(),
        errorRate: 1,
      };
      this.healthCache.set(name, failedHealth);
      return failedHealth;
    }
  }
}
