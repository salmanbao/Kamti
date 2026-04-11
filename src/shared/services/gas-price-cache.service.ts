import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from './winston-logger.service';
import { createPublicClient, http, parseGwei, formatGwei } from 'viem';
import { getViemChain } from '../utils/viem.utils';

/**
 * Gas price information with EIP-1559 support
 */
export interface GasPriceInfo {
  chainId: number;
  timestamp: number;
  legacy?: {
    gasPrice: string; // in wei
    gasPriceGwei: string;
  };
  eip1559?: {
    maxFeePerGas: string; // in wei
    maxPriorityFeePerGas: string; // in wei
    baseFeePerGas: string; // in wei
    maxFeePerGasGwei: string;
    maxPriorityFeePerGasGwei: string;
    baseFeePerGasGwei: string;
  };
  standard?: {
    gasPrice: string;
    gasPriceGwei: string;
  };
  fast?: {
    gasPrice: string;
    gasPriceGwei: string;
  };
  instant?: {
    gasPrice: string;
    gasPriceGwei: string;
  };
}

/**
 * Gas price caching service for EVM chains
 * Caches gas prices with TTL to reduce RPC calls
 */
@Injectable()
export class GasPriceCacheService {
  private readonly logger: WinstonLoggerService;

  // Cache structure: Map<chainId, { data: GasPriceInfo, expiresAt: number }>
  private cache = new Map<number, { data: GasPriceInfo; expiresAt: number }>();

  // Default TTL: 10 seconds
  private readonly defaultTtl = 10_000;

  // Chain-specific TTLs (in milliseconds)
  private readonly chainTtls = new Map<number, number>([
    [1, 12_000], // Ethereum: 12s (block time)
    [56, 3_000], // BSC: 3s (fast blocks)
    [137, 2_000], // Polygon: 2s (very fast blocks)
    [43114, 2_000], // Avalanche: 2s
    [42161, 1_000], // Arbitrum: 1s (L2)
    [10, 2_000], // Optimism: 2s (L2)
    [8453, 2_000], // Base: 2s (L2)
  ]);

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(GasPriceCacheService.name);
  }

  /**
   * Get gas price for a chain (with caching)
   */
  async getGasPrice(
    chainId: number,
    forceRefresh = false,
  ): Promise<GasPriceInfo> {
    // Check cache first
    if (!forceRefresh) {
      const cached = this.getCached(chainId);
      if (cached) {
        this.logger.debug(`Gas price cache HIT for chain ${chainId}`);
        return cached;
      }
    }

    this.logger.debug(
      `Gas price cache MISS for chain ${chainId}, fetching fresh data`,
    );

    // Fetch fresh gas price
    const gasPrice = await this.fetchGasPrice(chainId);

    // Store in cache
    this.setCached(chainId, gasPrice);

    return gasPrice;
  }

  /**
   * Get cached gas price if still valid
   */
  private getCached(chainId: number): GasPriceInfo | null {
    const entry = this.cache.get(chainId);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(chainId);
      return null;
    }

    return entry.data;
  }

  /**
   * Store gas price in cache
   */
  private setCached(chainId: number, data: GasPriceInfo): void {
    const ttl = this.chainTtls.get(chainId) || this.defaultTtl;
    const expiresAt = Date.now() + ttl;

    this.cache.set(chainId, { data, expiresAt });
  }

  /**
   * Fetch fresh gas price from RPC
   */
  private async fetchGasPrice(chainId: number): Promise<GasPriceInfo> {
    try {
      const chain = getViemChain(chainId);
      const client = createPublicClient({
        chain,
        transport: http(),
      });

      const timestamp = Date.now();

      // Check if chain supports EIP-1559
      const supportsEip1559 = await this.supportsEip1559(chainId);

      if (supportsEip1559) {
        // Fetch EIP-1559 gas prices
        const [feeHistory, gasPrice] = await Promise.all([
          client.getFeeHistory({
            blockCount: 4,
            rewardPercentiles: [25, 50, 75],
          }),
          client.getGasPrice().catch(() => null),
        ]);

        const latestBaseFee =
          feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1];

        // Calculate priority fee (median from fee history)
        const rewards = feeHistory.reward || [];
        const medianPriorityFee = this.calculateMedian(
          rewards.map((r) => r[1] || 0n), // 50th percentile
        );

        // Calculate maxFeePerGas (base fee * 2 + priority fee for safety)
        const maxFeePerGas = latestBaseFee * 2n + medianPriorityFee;

        const result: GasPriceInfo = {
          chainId,
          timestamp,
          eip1559: {
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: medianPriorityFee.toString(),
            baseFeePerGas: latestBaseFee.toString(),
            maxFeePerGasGwei: formatGwei(maxFeePerGas),
            maxPriorityFeePerGasGwei: formatGwei(medianPriorityFee),
            baseFeePerGasGwei: formatGwei(latestBaseFee),
          },
        };

        // Add legacy gas price if available
        if (gasPrice) {
          result.legacy = {
            gasPrice: gasPrice.toString(),
            gasPriceGwei: formatGwei(gasPrice),
          };
        }

        // Add tiered pricing
        this.addTieredPricing(result, latestBaseFee, medianPriorityFee);

        return result;
      } else {
        // Legacy gas price for non-EIP-1559 chains
        const gasPrice = await client.getGasPrice();

        const result: GasPriceInfo = {
          chainId,
          timestamp,
          legacy: {
            gasPrice: gasPrice.toString(),
            gasPriceGwei: formatGwei(gasPrice),
          },
        };

        // Add tiered pricing based on legacy gas price
        const gasPriceBigInt = BigInt(gasPrice);
        result.standard = {
          gasPrice: gasPrice.toString(),
          gasPriceGwei: formatGwei(gasPrice),
        };
        result.fast = {
          gasPrice: ((gasPriceBigInt * 120n) / 100n).toString(), // +20%
          gasPriceGwei: formatGwei((gasPriceBigInt * 120n) / 100n),
        };
        result.instant = {
          gasPrice: ((gasPriceBigInt * 150n) / 100n).toString(), // +50%
          gasPriceGwei: formatGwei((gasPriceBigInt * 150n) / 100n),
        };

        return result;
      }
    } catch (error) {
      this.logger.error(
        `Failed to fetch gas price for chain ${chainId}: ${error.message}`,
      );
      throw new Error(
        `Failed to fetch gas price for chain ${chainId}: ${error.message}`,
      );
    }
  }

  /**
   * Check if chain supports EIP-1559
   */
  private async supportsEip1559(chainId: number): Promise<boolean> {
    // Known EIP-1559 chains
    const eip1559Chains = [
      1, // Ethereum
      5, // Goerli
      11155111, // Sepolia
      137, // Polygon
      42161, // Arbitrum
      10, // Optimism
      8453, // Base
      43114, // Avalanche
      1101, // Polygon zkEVM
    ];

    return eip1559Chains.includes(chainId);
  }

  /**
   * Add tiered pricing for EIP-1559
   */
  private addTieredPricing(
    result: GasPriceInfo,
    baseFee: bigint,
    medianPriority: bigint,
  ): void {
    // Standard: base + median priority
    const standard = baseFee + medianPriority;
    result.standard = {
      gasPrice: standard.toString(),
      gasPriceGwei: formatGwei(standard),
    };

    // Fast: base * 1.2 + priority * 1.5
    const fast = (baseFee * 120n) / 100n + (medianPriority * 150n) / 100n;
    result.fast = {
      gasPrice: fast.toString(),
      gasPriceGwei: formatGwei(fast),
    };

    // Instant: base * 1.5 + priority * 2
    const instant = (baseFee * 150n) / 100n + medianPriority * 2n;
    result.instant = {
      gasPrice: instant.toString(),
      gasPriceGwei: formatGwei(instant),
    };
  }

  /**
   * Calculate median from array of bigints
   */
  private calculateMedian(values: bigint[]): bigint {
    if (values.length === 0) {
      return 0n;
    }

    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2n;
    }

    return sorted[mid];
  }

  /**
   * Clear cache for a specific chain or all chains
   */
  clearCache(chainId?: number): void {
    if (chainId !== undefined) {
      this.cache.delete(chainId);
      this.logger.debug(`Cleared gas price cache for chain ${chainId}`);
    } else {
      this.cache.clear();
      this.logger.debug('Cleared all gas price caches');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    chains: number[];
    entries: Array<{ chainId: number; age: number; ttl: number }>;
  } {
    const entries = Array.from(this.cache.entries()).map(
      ([chainId, entry]) => ({
        chainId,
        age: Date.now() - entry.data.timestamp,
        ttl: entry.expiresAt - Date.now(),
      }),
    );

    return {
      size: this.cache.size,
      chains: Array.from(this.cache.keys()),
      entries,
    };
  }

  /**
   * Warm up cache for specific chains
   */
  async warmUpCache(chainIds: number[]): Promise<void> {
    this.logger.log(`Warming up gas price cache for ${chainIds.length} chains`);

    const promises = chainIds.map((chainId) =>
      this.getGasPrice(chainId, true).catch((error) => {
        this.logger.warn(
          `Failed to warm up cache for chain ${chainId}: ${error.message}`,
        );
      }),
    );

    await Promise.all(promises);
    this.logger.log('Gas price cache warm-up complete');
  }
}
