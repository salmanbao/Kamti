import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from './winston-logger.service';
import { CustomHttpService } from './http.service';

export interface ChainInfo {
  chainId: number;
  name: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  shortName: string;
  network?: string;
  networkId?: number;
  slip44?: number;
  ens?: {
    registry: string;
  };
  explorers?: Array<{
    name: string;
    url: string;
    standard: string;
  }>;
  infoURL?: string;
  faucets?: string[];
  features?: Array<{
    name: string;
  }>;
  status?: string;
  icon?: string;
}

export interface ChainListResponse extends Array<ChainInfo> {}

export interface ChainListApiChain {
  chainId: number;
  name: string;
  chain: string;
  shortName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpc: Array<{
    url: string;
    tracking?: string;
  }>;
  faucets: string[];
  infoURL?: string;
  explorers?: Array<{
    name: string;
    url: string;
    standard: string;
    icon?: string;
  }>;
  icon?: string;
  status?: string;
  networkId?: number;
  slip44?: number;
  parent?: {
    type: string;
    chain: string;
    bridges?: Array<{
      url: string;
    }>;
  };
  tvl?: number;
  chainSlug?: string;
}

export interface EnhancedChainInfo {
  chainId: number;
  name: string;
  shortName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  network?: string;
  infoURL?: string;
  explorers?: Array<{
    name: string;
    url: string;
    standard: string;
  }>;
  icon?: string;
}

/**
 * Service to fetch and cache chain information from ChainList API
 */
@Injectable()
export class ChainListService {
  private readonly logger: WinstonLoggerService;
  private readonly chainListUrl = 'https://chainlist.org/rpcs.json';
  private readonly cacheKey = 'chainlist_data';
  private readonly cacheTtl = 24 * 60 * 60 * 1000; // 24 hours

  // In-memory cache for chain data
  private chainCache: Map<number, EnhancedChainInfo> = new Map();
  private lastCacheUpdate: number = 0;

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(ChainListService.name);
  }

  /**
   * Get enhanced chain information for supported chain IDs
   */
  async getChainInfo(chainIds: number[]): Promise<EnhancedChainInfo[]> {
    try {
      await this.ensureCacheLoaded();

      const chainInfos: EnhancedChainInfo[] = [];

      for (const chainId of chainIds) {
        const chainInfo = this.chainCache.get(chainId);
        if (chainInfo) {
          chainInfos.push(chainInfo);
        } else {
          // Fallback for unknown chains
          this.logger.warn(
            `Chain ${chainId} not found in ChainList, using fallback data`,
          );
          chainInfos.push(this.createFallbackChainInfo(chainId));
        }
      }

      // Sort by chainId
      return chainInfos.sort((a, b) => a.chainId - b.chainId);
    } catch (error) {
      this.logger.error(
        `Failed to get chain info: ${error.message}`,
        error.stack,
      );

      // Return fallback data for all chain IDs if API fails
      return chainIds.map((chainId) => this.createFallbackChainInfo(chainId));
    }
  }

  /**
   * Get single chain information by chain ID
   */
  async getSingleChainInfo(chainId: number): Promise<EnhancedChainInfo | null> {
    try {
      await this.ensureCacheLoaded();
      return this.chainCache.get(chainId) || null;
    } catch (error) {
      this.logger.error(
        `Failed to get chain info for ${chainId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Ensure cache is loaded and up to date
   */
  private async ensureCacheLoaded(): Promise<void> {
    const now = Date.now();

    if (
      this.chainCache.size === 0 ||
      now - this.lastCacheUpdate > this.cacheTtl
    ) {
      this.logger.log('Loading chain data from ChainList API...');
      await this.loadChainData();
    }
  }

  /**
   * Load chain data from ChainList API
   */
  private async loadChainData(): Promise<void> {
    try {
      this.logger.debug(`Fetching chain data from ${this.chainListUrl}`);

      const response = await this.httpService.get<ChainListApiChain[]>(
        this.chainListUrl,
        {
          timeout: 15000,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Aggregator-AML-APIs/1.0',
          },
        },
      );

      // Clear existing cache
      this.chainCache.clear();

      // Process and cache chain data - response is an array
      let processedCount = 0;
      if (Array.isArray(response)) {
        for (const chainData of response) {
          if (
            chainData &&
            chainData.chainId &&
            chainData.name &&
            chainData.nativeCurrency
          ) {
            const enhancedInfo: EnhancedChainInfo = {
              chainId: chainData.chainId,
              name: chainData.name,
              shortName: chainData.shortName,
              nativeCurrency: {
                name: chainData.nativeCurrency.name,
                symbol: chainData.nativeCurrency.symbol,
                decimals: chainData.nativeCurrency.decimals,
              },
              network: chainData.chain, // Use 'chain' field from API as network
              infoURL: chainData.infoURL,
              explorers: chainData.explorers,
              icon: chainData.icon,
            };

            this.chainCache.set(chainData.chainId, enhancedInfo);
            processedCount++;
          }
        }
      } else {
        this.logger.error('ChainList API response is not an array');
      }

      this.lastCacheUpdate = Date.now();
      this.logger.log(
        `Successfully loaded ${processedCount} chains from ChainList API`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to load chain data from ChainList: ${error.message}`,
        error.stack,
      );

      // If cache is empty and API fails, load fallback data
      if (this.chainCache.size === 0) {
        this.loadFallbackChainData();
      }

      throw error;
    }
  }

  /**
   * Load fallback chain data for common chains
   */
  private loadFallbackChainData(): void {
    const fallbackChains: EnhancedChainInfo[] = [
      {
        chainId: 1,
        name: 'Ethereum Mainnet',
        shortName: 'eth',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      {
        chainId: 10,
        name: 'Optimism',
        shortName: 'oeth',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      {
        chainId: 56,
        name: 'BNB Smart Chain Mainnet',
        shortName: 'bnb',
        nativeCurrency: { name: 'BNB Token', symbol: 'BNB', decimals: 18 },
      },
      {
        chainId: 137,
        name: 'Polygon Mainnet',
        shortName: 'matic',
        nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
      },
      {
        chainId: 8453,
        name: 'Base',
        shortName: 'base',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      {
        chainId: 42161,
        name: 'Arbitrum One',
        shortName: 'arb1',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      {
        chainId: 43114,
        name: 'Avalanche C-Chain',
        shortName: 'avax',
        nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
      },
    ];

    fallbackChains.forEach((chain) => {
      this.chainCache.set(chain.chainId, chain);
    });

    this.logger.warn(
      `Loaded ${fallbackChains.length} fallback chains due to API failure`,
    );
  }

  /**
   * Create fallback chain info for unknown chains
   */
  private createFallbackChainInfo(chainId: number): EnhancedChainInfo {
    const knownChains: Record<number, Partial<EnhancedChainInfo>> = {
      1: {
        name: 'Ethereum Mainnet',
        shortName: 'eth',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      10: {
        name: 'Optimism',
        shortName: 'oeth',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      56: {
        name: 'BNB Smart Chain Mainnet',
        shortName: 'bnb',
        nativeCurrency: { name: 'BNB Token', symbol: 'BNB', decimals: 18 },
      },
      100: {
        name: 'Gnosis',
        shortName: 'gno',
        nativeCurrency: { name: 'xDAI', symbol: 'XDAI', decimals: 18 },
      },
      137: {
        name: 'Polygon Mainnet',
        shortName: 'matic',
        nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
      },
      250: {
        name: 'Fantom Opera',
        shortName: 'ftm',
        nativeCurrency: { name: 'Fantom', symbol: 'FTM', decimals: 18 },
      },
      324: {
        name: 'zkSync Era',
        shortName: 'zksync',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      8453: {
        name: 'Base',
        shortName: 'base',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      42161: {
        name: 'Arbitrum One',
        shortName: 'arb1',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      },
      43114: {
        name: 'Avalanche C-Chain',
        shortName: 'avax',
        nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
      },
    };

    const knownChain = knownChains[chainId];

    return {
      chainId,
      name: knownChain?.name || `Chain ${chainId}`,
      shortName: knownChain?.shortName || `chain-${chainId}`,
      nativeCurrency: knownChain?.nativeCurrency || {
        name: 'Unknown',
        symbol: 'UNKNOWN',
        decimals: 18,
      },
    };
  }

  /**
   * Clear cache (useful for testing or forced refresh)
   */
  clearCache(): void {
    this.chainCache.clear();
    this.lastCacheUpdate = 0;
    this.logger.debug('ChainList cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; lastUpdate: Date | null; ttl: number } {
    return {
      size: this.chainCache.size,
      lastUpdate: this.lastCacheUpdate ? new Date(this.lastCacheUpdate) : null,
      ttl: this.cacheTtl,
    };
  }
}
