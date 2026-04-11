import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  UnifiedTokenConfig,
  UnifiedChainConfig,
  TokenDeployment,
  ConfigValidationError,
  UNIFIED_TOKENS,
  UNIFIED_CHAINS,
  getUnifiedTokenConfig,
  getUnifiedChainConfig,
  getTokensOnChain,
  getTokenAddress,
  getSupportedChains,
  getSupportedTokens,
  getTokenCrossChainDeployments,
  validateTokenChainConfiguration,
  normalizeChainId,
} from '@shared/config/unified-token-configuration.config';
import { BlockchainEcosystem } from '@swap/dto/universal-swap-request.dto';

// ==================== INTERFACES ====================

export interface TokenValidationResult {
  isValid: boolean;
  token?: UnifiedTokenConfig;
  deployment?: TokenDeployment;
  chainConfig?: UnifiedChainConfig;
  error?: ConfigValidationError;
  message?: string;
}

export interface ChainValidationResult {
  isValid: boolean;
  chainConfig?: UnifiedChainConfig;
  error?: ConfigValidationError;
  message?: string;
}

export interface SwapValidationResult {
  isValid: boolean;
  fromTokenValid: boolean;
  toTokenValid: boolean;
  fromChainValid: boolean;
  toChainValid: boolean;
  swapType:
    | 'same-token-cross-chain'
    | 'different-tokens-same-chain'
    | 'different-tokens-cross-chain'
    | 'same-token-same-chain';
  errors: string[];
  warnings: string[];
  fromToken?: UnifiedTokenConfig;
  toToken?: UnifiedTokenConfig;
  fromChain?: UnifiedChainConfig;
  toChain?: UnifiedChainConfig;
}

export interface ConfigurationStatistics {
  tokens: {
    total: number;
    enabled: number;
    native: number;
    stablecoins: number;
    crossChain: number;
    ecosystemBreakdown: Record<string, number>;
  };
  chains: {
    total: number;
    enabled: number;
    testnet: number;
    ecosystemBreakdown: Record<string, number>;
  };
  deployments: {
    total: number;
    enabled: number;
    perChain: Record<string, number>;
  };
}

// ==================== UNIFIED CONFIGURATION SERVICE ====================

/**
 * Unified Configuration Service
 * Single service for all token and chain configuration management
 *
 * Replaces both TokenMappingService and ChainConfigurationService
 * Follows Single Responsibility Principle with unified data source
 */
@Injectable()
export class UnifiedConfigurationService {
  // Cache for performance optimization
  private readonly tokenValidationCache = new Map<
    string,
    TokenValidationResult
  >();
  private readonly chainValidationCache = new Map<
    string,
    ChainValidationResult
  >();
  private readonly swapValidationCache = new Map<
    string,
    SwapValidationResult
  >();

  // Configuration versioning
  private configurationVersion: number = 1;
  private lastConfigUpdate: Date = new Date();

  constructor(private readonly logger: WinstonLoggerService) {
    this.logger.setContext(UnifiedConfigurationService.name);
    this.logger.log('🔧 UnifiedConfigurationService initialized');
    this.logConfigurationSummary();
  }

  // ==================== CHAIN VALIDATION ====================

  /**
   * Validate if a chain is supported and enabled
   */
  validateChainSupport(chainId: string | number): ChainValidationResult {
    const cacheKey = `chain_${chainId}`;

    // Check cache first
    if (this.chainValidationCache.has(cacheKey)) {
      return this.chainValidationCache.get(cacheKey)!;
    }

    const chainConfig = getUnifiedChainConfig(chainId);

    let result: ChainValidationResult;

    if (!chainConfig) {
      result = {
        isValid: false,
        error: ConfigValidationError.CHAIN_NOT_FOUND,
        message: `Chain ${chainId} is not configured`,
      };
    } else if (!chainConfig.isEnabled) {
      result = {
        isValid: false,
        chainConfig,
        error: ConfigValidationError.CHAIN_DISABLED,
        message: `Chain ${chainId} (${chainConfig.name}) is disabled`,
      };
    } else {
      result = {
        isValid: true,
        chainConfig,
      };
    }

    // Cache result
    this.chainValidationCache.set(cacheKey, result);
    return result;
  }

  /**
   * Validate native currency support on a chain
   */
  validateNativeCurrencySupport(
    chainId: string | number,
  ): ChainValidationResult {
    const chainValidation = this.validateChainSupport(chainId);

    if (!chainValidation.isValid) {
      return chainValidation;
    }

    const chainConfig = chainValidation.chainConfig!;

    if (!chainConfig.nativeCurrency.isEnabled) {
      return {
        isValid: false,
        chainConfig,
        error: ConfigValidationError.NATIVE_CURRENCY_DISABLED,
        message: `Native currency ${chainConfig.nativeCurrency.symbol} is disabled on ${chainConfig.name}`,
      };
    }

    return {
      isValid: true,
      chainConfig,
    };
  }

  // ==================== TOKEN VALIDATION ====================

  /**
   * Validate token on a specific chain
   */
  validateTokenOnChain(
    chainId: string | number,
    tokenSymbol: string,
  ): TokenValidationResult {
    const cacheKey = `token_${tokenSymbol}_${chainId}`;

    // Check cache first
    if (this.tokenValidationCache.has(cacheKey)) {
      return this.tokenValidationCache.get(cacheKey)!;
    }

    const validation = validateTokenChainConfiguration(tokenSymbol, chainId);
    const token = getUnifiedTokenConfig(tokenSymbol, chainId);
    const chainConfig = getUnifiedChainConfig(chainId);

    let result: TokenValidationResult;

    if (!validation.isValid) {
      result = {
        isValid: false,
        token: token || undefined,
        chainConfig: chainConfig || undefined,
        error: validation.error,
        message: validation.message,
      };
    } else {
      const normalizedChainId = normalizeChainId(chainId);
      const baseToken = getUnifiedTokenConfig(tokenSymbol);
      const deployment =
        baseToken?.chainDeployments[normalizedChainId.toString()];
      result = {
        isValid: true,
        token: token || undefined,
        deployment,
        chainConfig: chainConfig || undefined,
      };
    }

    // Cache result
    this.tokenValidationCache.set(cacheKey, result);
    return result;
  }

  /**
   * Validate if token is native currency on chain
   */
  isTokenNativeCurrency(
    tokenSymbol: string,
    chainId: string | number,
  ): boolean {
    const chainConfig = getUnifiedChainConfig(chainId);
    return (
      chainConfig?.nativeCurrency.symbol.toLowerCase() ===
        tokenSymbol.toLowerCase() || false
    );
  }

  // ==================== SWAP VALIDATION ====================

  /**
   * Validate hierarchical swap request
   */
  validateHierarchicalSwap(
    fromChain: string | number,
    fromToken: string,
    toChain: string | number,
    toToken: string,
  ): SwapValidationResult {
    const cacheKey = `swap_${fromToken}_${fromChain}_${toToken}_${toChain}`;

    // Check cache first
    if (this.swapValidationCache.has(cacheKey)) {
      return this.swapValidationCache.get(cacheKey)!;
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate from chain and token
    const fromChainValidation = this.validateChainSupport(fromChain);
    const fromTokenValidation = this.validateTokenOnChain(fromChain, fromToken);

    // Validate to chain and token
    const toChainValidation = this.validateChainSupport(toChain);
    const toTokenValidation = this.validateTokenOnChain(toChain, toToken);

    // Collect errors
    if (!fromChainValidation.isValid) {
      errors.push(
        fromChainValidation.message ||
          `Source chain ${fromChain} validation failed`,
      );
    }
    if (!fromTokenValidation.isValid) {
      // Check if it's native currency
      if (this.isTokenNativeCurrency(fromToken, fromChain)) {
        const nativeValidation = this.validateNativeCurrencySupport(fromChain);
        if (!nativeValidation.isValid) {
          errors.push(
            nativeValidation.message ||
              `Native currency ${fromToken} validation failed`,
          );
        }
      } else {
        errors.push(
          fromTokenValidation.message ||
            `Source token ${fromToken} validation failed`,
        );
      }
    }

    if (!toChainValidation.isValid) {
      errors.push(
        toChainValidation.message ||
          `Destination chain ${toChain} validation failed`,
      );
    }
    if (!toTokenValidation.isValid) {
      // Check if it's native currency
      if (this.isTokenNativeCurrency(toToken, toChain)) {
        const nativeValidation = this.validateNativeCurrencySupport(toChain);
        if (!nativeValidation.isValid) {
          errors.push(
            nativeValidation.message ||
              `Native currency ${toToken} validation failed`,
          );
        }
      } else {
        errors.push(
          toTokenValidation.message ||
            `Destination token ${toToken} validation failed`,
        );
      }
    }

    // Determine swap type
    let swapType: SwapValidationResult['swapType'];
    const sameToken = fromToken.toLowerCase() === toToken.toLowerCase();
    const sameChain = fromChain.toString() === toChain.toString();

    if (sameToken && sameChain) {
      swapType = 'same-token-same-chain';
      warnings.push('Same token on same chain - no swap needed');
    } else if (sameToken && !sameChain) {
      swapType = 'same-token-cross-chain';
    } else if (!sameToken && sameChain) {
      swapType = 'different-tokens-same-chain';
    } else {
      swapType = 'different-tokens-cross-chain';
    }

    const result: SwapValidationResult = {
      isValid: errors.length === 0,
      fromTokenValid:
        fromTokenValidation.isValid ||
        this.isTokenNativeCurrency(fromToken, fromChain),
      toTokenValid:
        toTokenValidation.isValid ||
        this.isTokenNativeCurrency(toToken, toChain),
      fromChainValid: fromChainValidation.isValid,
      toChainValid: toChainValidation.isValid,
      swapType,
      errors,
      warnings,
      fromToken: fromTokenValidation.token,
      toToken: toTokenValidation.token,
      fromChain: fromChainValidation.chainConfig,
      toChain: toChainValidation.chainConfig,
    };

    // Cache result
    this.swapValidationCache.set(cacheKey, result);
    return result;
  }

  // ==================== CONFIGURATION GETTERS ====================

  /**
   * Get all supported chains
   */
  getAllChains(): UnifiedChainConfig[] {
    return Object.values(UNIFIED_CHAINS);
  }

  /**
   * Get enabled chains only
   */
  getEnabledChains(): UnifiedChainConfig[] {
    return getSupportedChains();
  }

  /**
   * Get chain configuration
   */
  getChainConfiguration(chainId: string | number): UnifiedChainConfig | null {
    return getUnifiedChainConfig(chainId);
  }

  /**
   * Get all supported tokens
   */
  getAllTokens(): UnifiedTokenConfig[] {
    return Object.values(UNIFIED_TOKENS);
  }

  /**
   * Get enabled tokens only
   */
  getEnabledTokens(): UnifiedTokenConfig[] {
    return getSupportedTokens();
  }

  /**
   * Get token configuration
   */
  getTokenConfiguration(symbol: string): UnifiedTokenConfig | null {
    return getUnifiedTokenConfig(symbol);
  }

  /**
   * Get tokens available on a specific chain
   */
  getTokensForChain(chainId: string | number): UnifiedTokenConfig[] {
    return getTokensOnChain(chainId);
  }

  /**
   * Get token address on specific chain
   */
  getTokenAddressOnChain(
    symbol: string,
    chainId: string | number,
  ): string | null {
    return getTokenAddress(symbol, chainId);
  }

  /**
   * Get cross-chain deployments for token
   */
  getTokenCrossChainInfo(symbol: string): Record<string, TokenDeployment> {
    return getTokenCrossChainDeployments(symbol);
  }

  /**
   * Get chains by ecosystem
   */
  getChainsByEcosystem(ecosystem: BlockchainEcosystem): UnifiedChainConfig[] {
    return this.getEnabledChains().filter(
      (chain) => chain.ecosystem === ecosystem,
    );
  }

  /**
   * Get tokens by ecosystem
   */
  getTokensByEcosystem(ecosystem: BlockchainEcosystem): UnifiedTokenConfig[] {
    return this.getEnabledTokens().filter(
      (token) => token.ecosystem === ecosystem,
    );
  }

  // ==================== ADMIN FUNCTIONALITY ====================

  /**
   * Enable/disable chain
   */
  setChainStatus(
    chainId: string | number,
    enabled: boolean,
    adminId?: string,
  ): boolean {
    const chainConfig = getUnifiedChainConfig(chainId);
    if (!chainConfig) return false;

    chainConfig.isEnabled = enabled;
    this.clearCaches();
    this.updateConfigurationVersion();

    this.logger.log(
      `Chain ${chainId} (${chainConfig.name}) ${enabled ? 'enabled' : 'disabled'} by admin: ${adminId || 'system'}`,
    );

    return true;
  }

  /**
   * Enable/disable token globally
   */
  setTokenStatus(symbol: string, enabled: boolean, adminId?: string): boolean {
    const token = getUnifiedTokenConfig(symbol);
    if (!token) return false;

    token.isEnabled = enabled;
    this.clearCaches();
    this.updateConfigurationVersion();

    this.logger.log(
      `Token ${symbol} ${enabled ? 'enabled' : 'disabled'} globally by admin: ${adminId || 'system'}`,
    );

    return true;
  }

  /**
   * Enable/disable token on specific chain
   */
  setTokenStatusOnChain(
    symbol: string,
    chainId: string | number,
    enabled: boolean,
    adminId?: string,
  ): boolean {
    const token = getUnifiedTokenConfig(symbol);
    if (!token) return false;

    const deployment = token.chainDeployments[chainId.toString()];
    if (!deployment) return false;

    deployment.isEnabled = enabled;
    this.clearCaches();
    this.updateConfigurationVersion();

    this.logger.log(
      `Token ${symbol} on chain ${chainId} ${enabled ? 'enabled' : 'disabled'} by admin: ${adminId || 'system'}`,
    );

    return true;
  }

  // ==================== TOKEN INFO ENRICHMENT ====================

  /**
   * Enrich TokenInfo with data from unified configuration
   * Auto-resolves: address, standard, decimals from config based on symbol + chainId
   *
   * @param tokenInfo - Partial token info with at least symbol and chainId
   * @returns Enriched token info with all fields populated
   */
  enrichTokenInfo(tokenInfo: {
    symbol: string;
    chain: { chainId: number | string; ecosystem: BlockchainEcosystem };
    address?: string;
    standard?: any;
    decimals?: number;
  }): {
    symbol: string;
    address: string;
    standard: any;
    decimals: number;
    chain: { chainId: number | string; ecosystem: BlockchainEcosystem };
    isNative: boolean;
    coingeckoId?: string;
  } | null {
    const { symbol, chain } = tokenInfo;
    const { chainId } = chain;

    // Get token config with chain-specific overrides applied
    const tokenConfig = getUnifiedTokenConfig(symbol, chainId);
    if (!tokenConfig) {
      this.logger.warn(`Token ${symbol} not found in unified configuration`);
      return null;
    }

    // Get base token for deployment validation
    const baseToken = getUnifiedTokenConfig(symbol);
    if (!baseToken) {
      this.logger.warn(`Token ${symbol} not found in base configuration`);
      return null;
    }

    // Get chain-specific deployment for validation
    const normalizedChainId = normalizeChainId(chainId);
    const deployment = baseToken.chainDeployments[normalizedChainId.toString()];
    if (!deployment) {
      this.logger.warn(`Token ${symbol} has no deployment on chain ${chainId}`);
      return null;
    }

    if (!deployment.isEnabled) {
      this.logger.warn(
        `Token ${symbol} deployment is disabled on chain ${chainId}`,
      );
      return null;
    }

    // Use deployment-specific address or provided address
    const address = tokenInfo.address || deployment.address;

    // Use chain-specific decimals from tokenConfig (already has deployment override applied)
    // This ensures tokens like USDT use correct decimals (6 on ETH, 18 on BSC)
    const decimals = tokenInfo.decimals || tokenConfig.decimals;

    // Use provided standard or token's default standard
    const standard = tokenInfo.standard || tokenConfig.standard;

    return {
      symbol: tokenConfig.symbol,
      address,
      standard,
      decimals,
      chain,
      isNative: deployment.isNative || tokenConfig.isNative,
      coingeckoId: tokenConfig.coingeckoId,
    };
  }

  // ==================== TOKEN UTILITIES ====================

  /**
   * Unified token decimals resolver.
   * Applies deployment-specific overrides and consistent fallbacks across ecosystems.
   */
  getTokenDecimals(
    tokenAddress: string,
    chainId: number | string,
    tokenSymbol?: string,
  ): number {
    try {
      const normalizedChainId = normalizeChainId(chainId);
      const chainKey = normalizedChainId.toString();
      const chainConfig = getUnifiedChainConfig(normalizedChainId);

      // SUI: module path format handling
      if (tokenAddress?.includes?.('::')) {
        // Native SUI coin
        if (tokenAddress.includes('::sui::SUI')) return 9;
        // Default for other SUI tokens when unknown
        return 9;
      }

      const lowerAddr = tokenAddress?.toLowerCase?.() ?? tokenAddress;

      // Native token detection (EVM style + generic 'native')
      const isNative =
        lowerAddr === '0x0000000000000000000000000000000000000000' ||
        lowerAddr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
        lowerAddr === 'native' ||
        // Tron native
        lowerAddr === 'trx';

      if (isNative) {
        return chainConfig?.nativeCurrency.decimals ?? 18;
      }

      // Prefer symbol-based lookup when provided - uses chain-specific decimals
      if (tokenSymbol) {
        const tokenCfg = getUnifiedTokenConfig(tokenSymbol, chainId);
        if (tokenCfg) {
          // tokenCfg.decimals already has chain-specific override applied
          return tokenCfg.decimals;
        }
      }

      // Address-based lookup in unified configuration
      const all = Object.values(UNIFIED_TOKENS);
      for (const t of all) {
        const dep = t.chainDeployments[chainKey];
        if (dep && dep.address?.toLowerCase?.() === lowerAddr) {
          return dep.decimals ?? t.decimals;
        }
      }

      // Known EVM overrides (as last resort for popular tokens)
      const knownEvm: Record<string, number> = {
        // USDT
        '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // Ethereum
        '0x55d398326f99059ff775485246999027b3197955': 18, // BSC
        '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6, // Polygon
        // USDC
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // Ethereum
        '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18, // BSC
        '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 6, // Polygon
      };
      if (knownEvm[lowerAddr]) return knownEvm[lowerAddr];

      // Final fallback: use chain native decimals as heuristic
      // This keeps behavior consistent with prior code paths.
      return chainConfig?.nativeCurrency.decimals ?? 18;
    } catch (e: any) {
      this.logger.warn(
        `getTokenDecimals fallback: ${e?.message || e} for ${tokenAddress} on ${chainId}, returning 18`,
      );
      return 18;
    }
  }

  /**
   * Bulk enrich multiple token infos
   */
  enrichTokenInfos(
    tokenInfos: Array<{
      symbol: string;
      chain: { chainId: number | string; ecosystem: BlockchainEcosystem };
      address?: string;
      standard?: any;
      decimals?: number;
    }>,
  ): Array<{
    symbol: string;
    address: string;
    standard: any;
    decimals: number;
    chain: { chainId: number | string; ecosystem: BlockchainEcosystem };
    isNative: boolean;
    coingeckoId?: string;
  } | null> {
    return tokenInfos.map((tokenInfo) => this.enrichTokenInfo(tokenInfo));
  }

  // ==================== STATISTICS & HEALTH ====================

  /**
   * Get comprehensive configuration statistics
   */
  getConfigurationStatistics(): ConfigurationStatistics {
    const allTokens = this.getAllTokens();
    const enabledTokens = this.getEnabledTokens();
    const allChains = this.getAllChains();
    const enabledChains = this.getEnabledChains();

    // Token statistics
    const tokenEcosystemBreakdown: Record<string, number> = {};
    enabledTokens.forEach((token) => {
      tokenEcosystemBreakdown[token.ecosystem] =
        (tokenEcosystemBreakdown[token.ecosystem] || 0) + 1;
    });

    // Chain statistics
    const chainEcosystemBreakdown: Record<string, number> = {};
    enabledChains.forEach((chain) => {
      chainEcosystemBreakdown[chain.ecosystem] =
        (chainEcosystemBreakdown[chain.ecosystem] || 0) + 1;
    });

    // Deployment statistics
    let totalDeployments = 0;
    let enabledDeployments = 0;
    const deploymentsPerChain: Record<string, number> = {};

    enabledTokens.forEach((token) => {
      Object.entries(token.chainDeployments).forEach(
        ([chainId, deployment]) => {
          totalDeployments++;
          if (deployment.isEnabled) {
            enabledDeployments++;
            deploymentsPerChain[chainId] =
              (deploymentsPerChain[chainId] || 0) + 1;
          }
        },
      );
    });

    return {
      tokens: {
        total: allTokens.length,
        enabled: enabledTokens.length,
        native: enabledTokens.filter((t) => t.isNative).length,
        stablecoins: enabledTokens.filter((t) => t.isStablecoin).length,
        crossChain: enabledTokens.filter(
          (t) => Object.keys(t.chainDeployments).length > 1,
        ).length,
        ecosystemBreakdown: tokenEcosystemBreakdown,
      },
      chains: {
        total: allChains.length,
        enabled: enabledChains.length,
        testnet: enabledChains.filter((c) => c.isTestnet).length,
        ecosystemBreakdown: chainEcosystemBreakdown,
      },
      deployments: {
        total: totalDeployments,
        enabled: enabledDeployments,
        perChain: deploymentsPerChain,
      },
    };
  }

  /**
   * Health check for configuration service
   */
  getHealthStatus(): {
    status: 'healthy' | 'warning' | 'error';
    details: string[];
    statistics: ConfigurationStatistics;
  } {
    const details: string[] = [];
    const stats = this.getConfigurationStatistics();
    let status: 'healthy' | 'warning' | 'error' = 'healthy';

    // Check if we have enabled chains
    if (stats.chains.enabled === 0) {
      details.push('No enabled chains found');
      status = 'error';
    }

    // Check if we have enabled tokens
    if (stats.tokens.enabled === 0) {
      details.push('No enabled tokens found');
      status = 'error';
    }

    // Check if we have token deployments
    if (stats.deployments.enabled === 0) {
      details.push('No enabled token deployments found');
      status = 'error';
    }

    // Warnings
    if (stats.tokens.enabled < 5) {
      details.push('Low number of enabled tokens');
      status = status === 'error' ? 'error' : 'warning';
    }

    if (stats.chains.enabled < 3) {
      details.push('Low number of enabled chains');
      status = status === 'error' ? 'error' : 'warning';
    }

    if (details.length === 0) {
      details.push('All systems operational');
    }

    return {
      status,
      details,
      statistics: stats,
    };
  }

  // ==================== CACHE MANAGEMENT ====================

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.tokenValidationCache.clear();
    this.chainValidationCache.clear();
    this.swapValidationCache.clear();

    this.logger.debug('All caches cleared');
  }

  /**
   * Update configuration version
   */
  private updateConfigurationVersion(): void {
    this.configurationVersion++;
    this.lastConfigUpdate = new Date();
  }

  /**
   * Log configuration summary
   */
  private logConfigurationSummary(): void {
    const stats = this.getConfigurationStatistics();

    this.logger.log('📊 Unified Configuration Summary:');
    this.logger.log(
      `  🔗 Chains: ${stats.chains.enabled}/${stats.chains.total} enabled`,
    );
    this.logger.log(
      `  🪙 Tokens: ${stats.tokens.enabled}/${stats.tokens.total} enabled`,
    );
    this.logger.log(
      `  🚀 Deployments: ${stats.deployments.enabled}/${stats.deployments.total} enabled`,
    );
    this.logger.log(
      `  🌐 Ecosystems: ${Object.keys(stats.chains.ecosystemBreakdown).join(', ')}`,
    );
    this.logger.log(`  ✅ Configuration version: ${this.configurationVersion}`);
  }
}
