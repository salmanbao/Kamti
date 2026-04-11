import { Injectable, BadRequestException } from '@nestjs/common';
import { SwapCacheService } from './swap-cache.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  UniversalSwapRequestDto,
  SwapType,
  BlockchainEcosystem,
} from '@swap/dto/universal-swap-request.dto';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';

/**
 * Service for intelligent swap routing based on request characteristics
 *
 * ========================================================================
 * SWAP ROUTING STRATEGY OVERVIEW
 * ========================================================================
 *
 * This service analyzes swap requests and routes them to the appropriate
 * provider category based on blockchain ecosystems and swap complexity.
 *
 * PROVIDER CATEGORIES:
 *
 * 1️⃣ EVM-AGGREGATORS (Single-chain EVM swaps)
 *    Providers: 0x, Odos, Uniswap
 *    Use Case: ETH -> USDT on Ethereum
 *    Technology: DEX aggregation on single chain
 *
 * 2️⃣ META-AGGREGATORS (Cross-chain with bridges)
 *    PRIMARY: Symbiosis (50+ blockchains, EVM + Tron support)
 *    ALTERNATIVE: Rubic (360+ DEXs, 70+ blockchains, supports EVM-EVM, EVM-L2, EVM-L1, L1-L2)
 *    Use Cases:
 *      - ETH (Ethereum) -> USDC (Polygon) [CROSS_CHAIN]
 *      - ETH (L1) -> ETH (Arbitrum L2) [L1_TO_L2]
 *      - USDC (Optimism) -> USDC (Base) [L2_TO_L2]
 *      - TRX (Tron) -> ETH (Ethereum) [CROSS_CHAIN]
 *    Technology: Bridge protocols + DEX routing
 *    Bridges Used: Stargate, Across, Hop, Synapse, cBridge, Symbiosis, Rango
 *
 * 3️⃣ META (Cross-chain including native L1 via Rubic)
 *    PRIMARY: Symbiosis (cross-chain aggregator with 50+ blockchains including Tron support)
 *    ALTERNATIVE: Rubic (360+ DEXs, 70+ blockchains including Bitcoin, Litecoin, Dogecoin, Cardano, XRP, TON)
 *    Use Cases:
 *      - ETH (Ethereum) -> USDC (Polygon) [CROSS_CHAIN]
 *      - ETH (L1) -> ETH (Arbitrum L2) [L1_TO_L2]
 *      - USDC (Optimism) -> USDC (Base) [L2_TO_L2]
 *      - TRX (Tron) -> USDT (Ethereum) [CROSS_CHAIN via Symbiosis]
 *      - BTC (Bitcoin) -> ETH (Ethereum) [NATIVE_SWAP via Rubic]
 *      - DOGE (Dogecoin) -> SOL (Solana) [NATIVE_SWAP via Rubic]
 *    Technology: Bridge protocols + DEX routing + Native L1 cross-chain liquidity pools
 *    Key Features: Both providers handle bridges and cross-chain routing, Rubic also supports native L1 assets
 * 4️⃣ SOLANA (Single-chain Solana swaps)
 *    PRIMARY: Rubic (supports Solana via API v2)
 *    Use Case: SOL -> USDC on Solana
 *    Technology: Solana DEX aggregation (Rubic aggregates multiple Solana DEXs)
 *
 * ========================================================================
 * KEY DISTINCTION: META vs NATIVE-L1
 * ========================================================================
 *
 * WHY DIFFERENT CATEGORIES?
 *
 * 2. META-AGGREGATORS (Bridges) - PRIMARY: RUBIC:
 * ✅ Work with smart-contract blockchains (EVM, Solana)
 * ✅ Use token bridges (lock & mint mechanisms)
 * ✅ Can handle wrapped tokens (wBTC, wETH)
 * ✅ Rubic API v2 also supports native L1 chains (Bitcoin, Dogecoin, Cardano)
 * ✅ Aggregates 360+ DEXs across 70+ blockchains
 *
 * NATIVE-L1 PROVIDERS - RUBIC API v2:
 * ✅ Handle TRUE native assets (actual BTC, not wBTC)
 * ✅ Use liquidity pools instead of bridges
 * ✅ Work with non-smart-contract chains (Bitcoin, Litecoin, Dogecoin, Cardano, XRP, TON)
 * ✅ Provide native-to-native swaps (BTC -> ETH directly)
 * ✅ Rubic aggregates multiple native L1 liquidity sources
 *
 * Example:
 * - BTC (Bitcoin) -> ETH (Ethereum): Uses Rubic (NATIVE-L1)
 *   Why? Bitcoin has no smart contracts for bridges
 *
 * - ETH (Ethereum) -> SOL (Solana): Can use Rubic (META)
 *   Why? Both have smart contracts, can use Wormhole bridge
 *
 * ========================================================================
 */
@Injectable()
export class SwapRoutingService {
  // Registry of all provider instances for fallback support checks
  private providerRegistry: any[] = [];

  constructor(
    private readonly swapCacheService: SwapCacheService,
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.winstonLogger.setContext('SwapRoutingService');
  }

  /**
   * Set the provider registry (array of all provider instances)
   */
  setProviderRegistry(providers: any[]) {
    this.providerRegistry = providers;
  }

  /**
   * Get a cached route by ID for execution
   */
  getCachedRoute(routeId: string) {
    const route = this.swapCacheService.getRoute(routeId);
    if (route) {
      this.winstonLogger.debug(`Route cache hit: ${routeId}`);
    } else {
      this.winstonLogger.warn(`Route cache miss: ${routeId}`);
    }
    return route;
  }
  /**
   * Cache a route by ID for later execution/status checks
   */
  cacheRoute(routeId: string, route: any): void {
    this.swapCacheService.cacheRoute(routeId, route);
    this.winstonLogger.audit('ROUTE_CACHED', {
      routeId,
      aggregator: route.providerRef?.aggregator,
      swapType: route.swapType,
      timestamp: new Date().toISOString(),
    });
  }
  /**
   * Returns the spender address for approval checks (EVM: allowanceTarget from 0x/Odos, others: empty string)
   */
  async getSpenderForSwap(
    request: UniversalSwapRequestDto,
    aggregatorManager: any,
  ): Promise<string> {
    const swapType = this.determineSwapType(request);
    const providerCategory = this.determineProviderCategory(swapType, request);
    if (providerCategory === 'evm-aggregators') {
      // Try to get allowanceTarget from first available quote
      const legacyParams = {
        chainId: request.sellToken.chain.chainId,
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
      try {
        const quotes = await aggregatorManager.getMultipleQuotes(
          legacyParams.chainId,
          legacyParams.sellToken,
          legacyParams.buyToken,
          legacyParams.sellAmount,
          legacyParams.taker,
          legacyParams.recipient,
          legacyParams.slippagePercentage,
          legacyParams.deadline,
        );
        if (quotes.length > 0 && quotes[0].quote.allowanceTarget) {
          return quotes[0].quote.allowanceTarget;
        }
      } catch (e) {
        // Fallback: no allowanceTarget found
      }
    }
    // For non-EVM, or if no allowanceTarget found, return empty string
    return '';
  }

  /**
   * Determines the swap type based on the request
   *
   * SWAP TYPE DECISION TREE:
   *
   * 1. ON_CHAIN: Same chain, same ecosystem
   *    Example: ETH -> USDT on Ethereum (chain 1 -> chain 1)
   *    Provider: evm-aggregators, solana, etc.
   *
   * 2. NATIVE_SWAP: Different ecosystems involving native L1 blockchains
   *    Example: BTC (Bitcoin) -> ETH (Ethereum), DOGE -> SOL, ADA -> BNB
   *    Provider: native-l1 (THORChain, Maya Protocol)
   *    Uses: Native cross-chain liquidity pools (NO BRIDGES, NO WRAPPED TOKENS)
   *
   * 3. CROSS_CHAIN: Different ecosystems NOT involving native L1s
   *    Example: ETH (Ethereum) -> SOL (Solana), BNB (BSC) -> AVAX (Avalanche)
   *    Provider: meta (Rubic, Socket, Rango)
   *    Uses: Bridges + DEX aggregators
   *
   * 4. L1_TO_L2 / L2_TO_L1 / L2_TO_L2: EVM ecosystem with different chains
   *    Example: ETH (chain 1) -> ETH (Arbitrum 42161), Optimism -> Base
   *    Provider: meta (Rubic, Socket with bridge protocols)
   *    Uses: L1/L2 bridges (Stargate, Across, Hop)
   */
  determineSwapType(request: UniversalSwapRequestDto): SwapType {
    const sellChain = request.sellToken.chain;
    const buyChain = request.buyToken.chain;

    this.winstonLogger.debug(
      `Analyzing swap: ${sellChain.ecosystem}:${sellChain.chainId} -> ${buyChain.ecosystem}:${buyChain.chainId}`,
    );

    // If swap type is explicitly provided, validate and return it
    if (request.swapType) {
      if (this.validateSwapType(request, request.swapType)) {
        this.winstonLogger.audit('SWAP_TYPE_DETERMINED', {
          swapType: request.swapType,
          source: 'explicit',
          sellChain: `${sellChain.ecosystem}:${sellChain.chainId}`,
          buyChain: `${buyChain.ecosystem}:${buyChain.chainId}`,
          timestamp: new Date().toISOString(),
        });
        return request.swapType;
      }
      this.winstonLogger.warn(
        `Provided swap type ${request.swapType} doesn't match request characteristics, auto-detecting...`,
      );
    }

    let detectedSwapType: SwapType;

    // CASE 1: Same ecosystem and chain = ON_CHAIN swap
    // Uses single-chain DEX aggregators (0x, Odos, Rubic, etc.)
    if (
      sellChain.ecosystem === buyChain.ecosystem &&
      sellChain.chainId === buyChain.chainId
    ) {
      detectedSwapType = SwapType.ON_CHAIN;
    }
    // CASE 2: Different ecosystems = Either NATIVE_SWAP or CROSS_CHAIN
    else if (sellChain.ecosystem !== buyChain.ecosystem) {
      // CASE 2A: NATIVE_SWAP - Involves native L1 blockchains (Bitcoin, Cardano, etc.)
      // These swaps MUST use THORChain/Maya Protocol native pools
      // Example: BTC -> ETH, DOGE -> SOL, ADA -> BNB
      if (this.isNativeL1Swap(sellChain.ecosystem, buyChain.ecosystem)) {
        detectedSwapType = SwapType.NATIVE_SWAP;
      } else {
        // CASE 2B: CROSS_CHAIN - Between non-native L1 ecosystems
        // Uses meta aggregators with bridges (Rubic, Socket, Rango)
        // Example: ETH (Ethereum) -> SOL (Solana)
        detectedSwapType = SwapType.CROSS_CHAIN;
      }
    }
    // CASE 3: Same ecosystem, different chains
    else if (
      sellChain.ecosystem === buyChain.ecosystem &&
      sellChain.chainId !== buyChain.chainId
    ) {
      // CASE 3A: EVM chains - determine L1/L2 relationship for optimized routing
      if (sellChain.ecosystem === BlockchainEcosystem.EVM) {
        detectedSwapType = this.determineEvmSwapType(
          sellChain.chainId as number,
          buyChain.chainId as number,
        );
      } else {
        // CASE 3B: Non-EVM cross-chain (e.g., different Cosmos chains)
        detectedSwapType = SwapType.CROSS_CHAIN;
      }
    } else {
      throw new BadRequestException(
        'Unable to determine swap type from request',
      );
    }

    this.winstonLogger.audit('SWAP_TYPE_DETERMINED', {
      swapType: detectedSwapType,
      source: 'auto-detected',
      sellChain: `${sellChain.ecosystem}:${sellChain.chainId}`,
      buyChain: `${buyChain.ecosystem}:${buyChain.chainId}`,
      timestamp: new Date().toISOString(),
    });

    return detectedSwapType;
  }

  /**
   * Determines the appropriate provider category based on swap type
   *
   * PROVIDER CATEGORY MAPPING (RUBIC-FIRST STRATEGY):
   *
   * 1. evm-aggregators: Single-chain EVM swaps
   *    - Providers: 0x, Odos (specialized), Rubic (fallback)
   *    - Use Case: ETH -> USDT on Ethereum
   *
   * 2. meta: Cross-chain swaps using bridges
 *    - PRIMARY: Symbiosis (50+ chains including Tron, optimized bridge routing)
 *    - ALTERNATIVE: Rubic (360+ DEXs, 70+ chains, broader ecosystem coverage)
 *    - Use Case: ETH (Ethereum) -> USDC (Polygon), ETH (L1) -> ETH (Arbitrum L2), TRX (Tron) -> USDT (Ethereum)
 *    - Handles: CROSS_CHAIN, L1_TO_L2, L2_TO_L1, L2_TO_L2
 *    - Technology: Bridges (Stargate, Across, Hop, Symbiosis, cBridge) + DEX aggregation
   *
   * 3. native-l1: Native L1 blockchain swaps
   *    - PRIMARY: Rubic API v2 (Bitcoin, Litecoin, Dogecoin, Cardano, XRP, TON, etc.)

   *    - Use Case: BTC -> ETH, DOGE -> SOL, ADA -> BNB
   *    - Handles: NATIVE_SWAP
   *    - Technology: Native cross-chain liquidity pools (NO bridges or wrapped tokens)
   *
   * 4. solana: Single-chain Solana swaps
   *    - PRIMARY: Rubic (supports Solana via API v2)
   *    - Note: Rubic aggregates Solana DEXs internally
   *    - Use Case: SOL -> USDC on Solana
   */
  determineProviderCategory(
    swapType: SwapType,
    request: UniversalSwapRequestDto,
  ): 'evm-aggregators' | 'meta' | 'solana' {
    let category: 'evm-aggregators' | 'meta' | 'solana';

    switch (swapType) {
      case SwapType.ON_CHAIN:
        // Single-chain swaps - route to ecosystem-specific aggregators
        category = this.getOnChainProviderCategory(request);
        break;

      case SwapType.CROSS_CHAIN:
      case SwapType.L1_TO_L2:
      case SwapType.L2_TO_L1:
      case SwapType.L2_TO_L2:
      case SwapType.NATIVE_SWAP:
        // All cross-chain swaps use meta aggregators (Rubic handles Bitcoin/native L1s)
        // Meta aggregators handle bridge selection, DEX routing, and native L1 cross-chain swaps
        // Rubic Finance provides comprehensive Bitcoin, Litecoin, Dogecoin support via their platform
        category = 'meta';
        break;

      default:
        throw new BadRequestException(`Unsupported swap type: ${swapType}`);
    }

    this.winstonLogger.audit('PROVIDER_CATEGORY_SELECTED', {
      swapType,
      category,
      sellEcosystem: request.sellToken.chain.ecosystem,
      buyEcosystem: request.buyToken.chain.ecosystem,
      timestamp: new Date().toISOString(),
    });

    return category;
  }

  /**
   * Gets the best providers for the determined category
   */
  getProvidersForCategory(
    category: 'evm-aggregators' | 'meta' | 'solana',
    request: UniversalSwapRequestDto,
  ): string[] {
    switch (category) {
      case 'evm-aggregators':
        return this.getEvmAggregators(request);

      case 'meta':
        return this.getMetaAggregators(request);

      case 'solana':
        return this.getSolanaProviders(request);

      default:
        return [];
    }
  }

  /**
   * Validates chain compatibility for the swap
   */
  validateChainCompatibility(request: UniversalSwapRequestDto): boolean {
    const sellChain = request.sellToken.chain;
    const buyChain = request.buyToken.chain;

    // Check if ecosystems are supported
    if (
      !this.isSupportedEcosystem(sellChain.ecosystem) ||
      !this.isSupportedEcosystem(buyChain.ecosystem)
    ) {
      return false;
    }

    // Check specific chain support using cache service
    return this.isChainSupported(sellChain) && this.isChainSupported(buyChain);
  }

  /**
   * Estimates complexity and routing requirements
   */
  estimateSwapComplexity(request: UniversalSwapRequestDto): {
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedSteps: number;
    estimatedTime: number; // seconds
    recommendedProviders: string[];
  } {
    const swapType = this.determineSwapType(request);
    const category = this.determineProviderCategory(swapType, request);

    switch (swapType) {
      case SwapType.ON_CHAIN:
        return {
          complexity: 'simple',
          estimatedSteps: 1,
          estimatedTime: 30,
          recommendedProviders: this.getProvidersForCategory(
            category,
            request,
          ).slice(0, 2),
        };

      case SwapType.L1_TO_L2:
      case SwapType.L2_TO_L1:
        return {
          complexity: 'moderate',
          estimatedSteps: 2,
          estimatedTime: 180, // 3 minutes for L1/L2 bridges
          recommendedProviders: ['symbiosis', 'rubic'], // Symbiosis primary, Rubic alternative
        };

      case SwapType.CROSS_CHAIN:
        return {
          complexity: 'complex',
          estimatedSteps: this.estimateCrossChainSteps(request),
          estimatedTime: 600, // 10 minutes for complex cross-chain
          recommendedProviders: ['symbiosis', 'rubic'], // Symbiosis primary, Rubic for broader chain support
        };

      case SwapType.NATIVE_SWAP:
        return {
          complexity: 'moderate',
          estimatedSteps: 1,
          estimatedTime: 300, // 5 minutes for native L1 swaps
          recommendedProviders: ['symbiosis', 'rubic'], // Symbiosis primary, Rubic alternative
        };
      default:
        return {
          complexity: 'complex',
          estimatedSteps: 3,
          estimatedTime: 900,
          recommendedProviders: [],
        };
    }
  }

  private validateSwapType(
    request: UniversalSwapRequestDto,
    swapType: SwapType,
  ): boolean {
    // Create a copy without the swapType to avoid recursion
    const requestCopy = { ...request, swapType: undefined };
    try {
      const detected = this.determineSwapType(requestCopy);
      return detected === swapType;
    } catch (error) {
      this.winstonLogger.warn(
        `Failed to validate swap type ${swapType}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Checks if a swap involves native L1 blockchains that require specialized routing
   *
   * Uses unified configuration to determine which ecosystems are native L1 chains.
   * Native L1 ecosystems are those that have their own consensus and cannot use
   * traditional bridges, requiring specialized cross-chain protocols like Rubic
   * that maintain native liquidity pools for direct asset swaps.
   *
   * Examples:
   * - Bitcoin (BTC) - Original blockchain, no smart contracts
   * - Dogecoin (DOGE) - Bitcoin fork
   * - Litecoin (LTC) - Bitcoin fork
   * - Cardano (ADA) - eUTXO model blockchain
   * - XRP Ledger (XRP) - Ripple's native blockchain
   * - Cosmos (ATOM) - IBC-enabled chains
   * - Sui (SUI) - Move-based blockchain
   * - Hedera (HBAR) - Hashgraph consensus
   * - TON - Telegram Open Network
   *
   * NON-NATIVE L1s (use bridges instead):
   * - EVM chains (Ethereum, BSC, Polygon, etc.) - Can use bridges
   * - Solana - Can use Wormhole bridge
   *
   * @returns true if either source or destination is a native L1 blockchain
   */
  private isNativeL1Swap(
    sellEcosystem: BlockchainEcosystem,
    buyEcosystem: BlockchainEcosystem,
  ): boolean {
    return (
      this.isNativeL1Ecosystem(sellEcosystem) ||
      this.isNativeL1Ecosystem(buyEcosystem)
    );
  }

  /**
   * Determines if an ecosystem is a native L1 blockchain
   *
   * CENTRALIZED CONFIGURATION APPROACH:
   * Instead of maintaining hardcoded arrays, this method defines native L1 ecosystems
   * in one place. This makes it easy to add/remove ecosystems as support expands.
   *
   * Native L1 ecosystems are determined by checking which tokens in the unified
   * configuration use non-EVM, non-Solana ecosystems and require specialized
   * cross-chain protocols like Rubic's API v2.
   *
   * NATIVE L1 CHARACTERISTICS:
   * - Have their own consensus mechanism
   * - Cannot use traditional EVM-style bridges
   * - Require specialized cross-chain protocols
   * - Examples: Bitcoin (no smart contracts), Cardano (eUTXO), XRP (consensus ledger)
   *
   * @param ecosystem - The blockchain ecosystem to check
   * @returns true if the ecosystem is a native L1 blockchain
   */
  private isNativeL1Ecosystem(ecosystem: BlockchainEcosystem): boolean {
    // Define native L1 ecosystems that require specialized cross-chain protocols
    // TODO: Consider moving this to unified configuration as well for complete centralization
    const nativeL1Ecosystems = [
      BlockchainEcosystem.BITCOIN, // BTC, LTC, DOGE (Bitcoin-based)
      BlockchainEcosystem.SUBSTRATE, // DOT, KSM (Polkadot ecosystem)
      BlockchainEcosystem.THORCHAIN, // RUNE
      BlockchainEcosystem.MAYA, // CACAO
      BlockchainEcosystem.COSMOS, // ATOM and IBC chains
      BlockchainEcosystem.CARDANO, // ADA
      BlockchainEcosystem.SUI, // SUI
      BlockchainEcosystem.HEDERA, // HBAR
      BlockchainEcosystem.TON, // TON
      BlockchainEcosystem.XRPL, // XRP
    ];

    return nativeL1Ecosystems.includes(ecosystem);
  }

  /**
   * Determines EVM swap type based on L1/L2 chain relationships
   *
   * EVM CHAIN CLASSIFICATION:
   *
   * TRUE L1 CHAINS:
   * - Ethereum (1) - Original EVM blockchain
   *
   * TRUE L2 CHAINS (Rollups):
   * - Optimism (10) - Optimistic rollup
   * - Arbitrum One (42161) - Optimistic rollup
   * - Base (8453) - Optimism-based rollup
   * - zkSync Era (324) - ZK rollup
   * - Polygon zkEVM (1101) - ZK rollup
   * - Linea (59144) - ZK rollup
   * - Scroll (534352) - ZK rollup
   *
   * ALTERNATIVE L1s / SIDECHAINS (not true L2s):
   * - BSC (56) - Binance Smart Chain (independent validator set)
   * - Polygon PoS (137) - Sidechain (not a rollup)
   * - Avalanche (43114) - Independent blockchain
   * - Fantom (250) - Independent blockchain
   * - Cronos (25) - Crypto.com chain
   *
   * ROUTING LOGIC:
   * - L1 -> L2: Use official bridges (Optimism Bridge, Arbitrum Bridge)
   * - L2 -> L1: Withdrawal process (may take time due to fraud proofs)
   * - L2 -> L2: Use cross-L2 bridges (Hop, Across, Stargate)
   * - L1 <-> Alt L1: Use multi-chain bridges (Rubic)
   */
  private determineEvmSwapType(
    sellChainId: number,
    buyChainId: number,
  ): SwapType {
    // True L1 chains
    const l1Chains = [1]; // Ethereum mainnet only

    // L2 chains (rollups and scaling solutions)
    const l2Chains = [10, 42161, 8453, 324, 1101, 59144, 534352]; // Optimism, Arbitrum, Base, zkSync, Polygon zkEVM, Linea, Scroll

    // Alternative L1s / Sidechains (not true L2s but related ecosystems)
    const alternativeL1s = [56, 137, 43114, 250, 25]; // BSC, Polygon PoS, Avalanche, Fantom, Cronos

    const sellIsL1 = l1Chains.includes(sellChainId);
    const buyIsL1 = l1Chains.includes(buyChainId);
    const sellIsL2 = l2Chains.includes(sellChainId);
    const buyIsL2 = l2Chains.includes(buyChainId);
    const sellIsAltL1 = alternativeL1s.includes(sellChainId);
    const buyIsAltL1 = alternativeL1s.includes(buyChainId);

    // True L1 to L2 relationships - optimized with native bridges
    if (sellIsL1 && buyIsL2) return SwapType.L1_TO_L2;
    if (sellIsL2 && buyIsL1) return SwapType.L2_TO_L1;
    if (sellIsL2 && buyIsL2) return SwapType.L2_TO_L2;

    // L1 to alternative L1 (like ETH to BSC) - requires multi-chain bridges
    if (
      (sellIsL1 && buyIsAltL1) ||
      (sellIsAltL1 && buyIsL1) ||
      (sellIsAltL1 && buyIsAltL1)
    ) {
      return SwapType.CROSS_CHAIN;
    }

    return SwapType.CROSS_CHAIN; // Default for unrecognized EVM chains
  }

  private getOnChainProviderCategory(
    request: UniversalSwapRequestDto,
  ): 'evm-aggregators' | 'solana' | 'meta' {
    const ecosystem = request.sellToken.chain.ecosystem;

    switch (ecosystem) {
      case BlockchainEcosystem.EVM:
      case BlockchainEcosystem.AVALANCHE:
        // RUBIC-FIRST STRATEGY: Return 'meta' for EVM swaps
        // This ensures Rubic (meta aggregator) is tried first as primary provider
        // before falling back to EVM-specific aggregators (0x, Odos)
        // Rubic offers broader liquidity discovery across 70+ chains and 360+ DEXs
        return 'meta';

      case BlockchainEcosystem.SOLANA:
        return 'meta';
      case BlockchainEcosystem.TRON:
        return 'meta';
      // New ecosystems that need specialized handling
      case BlockchainEcosystem.CARDANO:
      case BlockchainEcosystem.SUI:
      case BlockchainEcosystem.HEDERA:
      case BlockchainEcosystem.TON:
      case BlockchainEcosystem.XRPL:
        // For now, throw an error as these don't have on-chain swap support yet
        throw new BadRequestException(
          `On-chain swaps not yet implemented for ecosystem: ${ecosystem}. Use cross-chain swaps instead.`,
        );

      default:
        throw new BadRequestException(
          `On-chain swaps not supported for ecosystem: ${ecosystem}`,
        );
    }
  }

  private getEvmAggregators(request: UniversalSwapRequestDto): string[] {
    const chainId = request.sellToken.chain.chainId as number;
    const userPreferredAggregator = request.preferredAggregator?.toLowerCase();

    // If user explicitly specifies a preferred aggregator, prioritize it
    if (userPreferredAggregator) {
      // Build list with user preference first
      const allProviders = ['symbiosis', 'rubic', 'odos', '0x'];
      const filtered = allProviders.filter(
        (p) => p === userPreferredAggregator || p !== userPreferredAggregator,
      );
      // Move preferred to front
      const index = filtered.indexOf(userPreferredAggregator);
      if (index > 0) {
        [filtered[0], filtered[index]] = [filtered[index], filtered[0]];
      }
      return filtered;
    }

    // Default preference order:
    // 1. Symbiosis (primary) - Best liquidity and features across multiple chains
    // 2. Rubic (secondary) - Cross-chain specialist with 70+ blockchains
    // 3. 0x / Odos (tertiary) - EVM-specific aggregators
    const preferenceOrder = ['symbiosis', 'rubic', 'odos', '0x'];
    const plannedProviders = ['uniswap']; // Placeholder for future

    // Chain-specific optimizations
    // PRIMARY: Symbiosis (multi-chain support with liquidity optimization)
    // SECONDARY: Rubic (comprehensive cross-chain DEX router)
    // TERTIARY: EVM-specific aggregators (0x, Odos) for EVM-only optimization
    switch (chainId) {
      case 1: // Ethereum
        return [...preferenceOrder, ...plannedProviders];
      case 137: // Polygon
        return [...preferenceOrder, ...plannedProviders];
      case 56: // BSC
        return [...preferenceOrder, ...plannedProviders];
      case 42161: // Arbitrum
        return [...preferenceOrder, ...plannedProviders];
      case 10: // Optimism
        return [...preferenceOrder, ...plannedProviders];
      case 43114: // Avalanche
        return [...preferenceOrder, ...plannedProviders];
      case 8453: // Base
        return [...preferenceOrder, ...plannedProviders];
      default:
        return [...preferenceOrder]; // Symbiosis > Rubic > Odos > 0x for any EVM chain
    }
  }

  private getMetaAggregators(request: UniversalSwapRequestDto): string[] {
    const userPreferredAggregator = request.preferredAggregator?.toLowerCase();

    // If user explicitly specifies Symbiosis or Rubic
    if (userPreferredAggregator === 'symbiosis') {
      return ['symbiosis', 'rubic']; // Symbiosis primary, Rubic as fallback
    }
    if (userPreferredAggregator === 'rubic') {
      return ['rubic', 'symbiosis']; // Rubic primary, Symbiosis as fallback
    }

    // Default preference order for cross-chain and native L1 swaps:
    // 1. Symbiosis (primary) - Supports multiple chains with liquidity optimization
    // 2. Rubic (secondary) - Cross-chain specialist, 70+ blockchains support
    return ['symbiosis', 'rubic'];
  }

  private getSolanaProviders(request: UniversalSwapRequestDto): string[] {
    // Solana swaps are currently served via meta aggregators (Rubic)
    return ['rubic'];
  }

  private isSupportedEcosystem(ecosystem: BlockchainEcosystem): boolean {
    // Use unified configuration to check if any chains exist for this ecosystem
    const enabledChains = this.unifiedConfig.getEnabledChains();
    return enabledChains.some((chain) => chain.ecosystem === ecosystem);
  }

  private isChainSupported(chain: any): boolean {
    // Generalized: check cache first, then fallback to provider's supportsChain
    if (!chain || !chain.chainId) return false;

    // Handle both numeric chainIds (EVM: 1, 56, etc.) and string chainIds (Bitcoin: "bitcoin-mainnet")
    const chainId = chain.chainId;
    const numericChainId =
      typeof chainId === 'string' ? parseInt(chainId, 10) : chainId;

    // For native L1 chains (Bitcoin, etc.), chainId is a string like "bitcoin-mainnet"
    // These are always supported if the ecosystem is in our supported list
    if (typeof chainId === 'string' && isNaN(numericChainId)) {
      // String-based chainId for native L1 blockchains (Bitcoin, Dogecoin, etc.)
      // Use unified configuration to check if chain is supported
      const chainConfig = this.unifiedConfig.getChainConfiguration(chainId);
      return chainConfig?.isEnabled || false;
    }

    // For numeric chainIds (EVM chains), check provider support
    // 1. For validation, we check if the chain itself is supported
    // Cache check is done per token, so we check if any token on this chain is cached
    // This is a lightweight check - if cache has any tokens for this chain, chain is supported

    // 2. Fallback: check all known providers for supportsChain
    if (
      this.providerRegistry &&
      Array.isArray(this.providerRegistry) &&
      this.providerRegistry.length > 0
    ) {
      for (const provider of this.providerRegistry) {
        if (provider && typeof provider.supportsChain === 'function') {
          const supported = provider.supportsChain(numericChainId);
          if (supported) {
            return true;
          }
        }
      }
      // If we have providers but none support this chain, return false
      return false;
    }

    // 3. Default fallback: if no providers registered yet, return true to allow bootstrapping
    // This allows initial requests to go through and populate the cache
    return true;
  }

  /**
   * Call this after a successful quote to cache supported chain/token pairs
   */
  cacheSupportedQuote(chainId: number, buyToken: string, sellToken: string) {
    this.swapCacheService.addSupportedQuote(chainId, buyToken, sellToken);
  }

  private estimateCrossChainSteps(request: UniversalSwapRequestDto): number {
    const sellEcosystem = request.sellToken.chain.ecosystem;
    const buyEcosystem = request.buyToken.chain.ecosystem;

    // Same ecosystem cross-chain (e.g., Ethereum to Polygon)
    if (sellEcosystem === buyEcosystem) {
      return 2; // Bridge + optional swap
    }

    // Different ecosystems (e.g., Ethereum to Solana)
    return 3; // Swap to bridge token + bridge + swap to target token
  }
}
