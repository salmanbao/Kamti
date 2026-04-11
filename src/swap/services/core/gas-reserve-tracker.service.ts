import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Transaction cost data point for adaptive learning
 */
interface TransactionCostData {
  timestamp: number;
  ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin';
  transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap';
  actualCost: bigint;
  balance: bigint;
  success: boolean;
  reserveUsed: bigint;
  chainId: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Statistical data for a specific transaction category
 */
interface ReserveStatistics {
  averageCost: bigint;
  maxCost: bigint;
  minCost: bigint;
  recentSamples: number;
  successRate: number;
  lastUpdated: number;
  // Percentile costs for more robust estimation
  p50Cost: bigint; // Median
  p75Cost: bigint;
  p90Cost: bigint;
  p95Cost: bigint;
}

/**
 * Gas Reserve Tracker Service
 *
 * Tracks actual transaction costs and dynamically adjusts gas reserves
 * based on historical data and failure patterns.
 *
 * Features:
 * - Per-ecosystem and per-transaction-type tracking
 * - Adaptive reserve calculation using percentile-based approach
 * - Failure pattern detection and automatic adjustment
 * - Configurable sample window for recent data
 * - Safe fallback to conservative minimums
 */
@Injectable()
export class GasReserveTrackerService {
  constructor(private readonly logger: WinstonLoggerService) {
    this.logger.setContext(GasReserveTrackerService.name);
  }

  // In-memory storage of transaction cost data (consider moving to Redis/DB for production)
  private readonly costHistory: Map<string, TransactionCostData[]> = new Map();

  // Maximum samples to keep per category (rolling window)
  private readonly MAX_SAMPLES = 100;

  // Minimum samples needed before trusting adaptive calculation
  private readonly MIN_SAMPLES_FOR_ADAPTIVE = 10;

  // Time window for "recent" transactions (24 hours)
  private readonly RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

  // Conservative fallback reserves when insufficient data
  private readonly FALLBACK_RESERVES = {
    solana: {
      simple: BigInt(1_500_000), // 0.0015 SOL
      'cross-chain': BigInt(3_000_000), // 0.003 SOL (current working value)
      bridge: BigInt(4_000_000), // 0.004 SOL
      swap: BigInt(2_000_000), // 0.002 SOL
    },
    evm: {
      // Ethereum mainnet (chainId 1) - high gas
      1: {
        simple: BigInt('10000000000000'), // 0.00001 ETH
        'cross-chain': BigInt('10000000000000'), // 0.00001 ETH
        bridge: BigInt('10000000000000'), // 0.00001 ETH
        swap: BigInt('10000000000000'), // 0.00001 ETH
      },
      // BSC (chainId 56) - low gas
      56: {
        simple: BigInt('10000000000000'), // 0.00001 BNB
        'cross-chain': BigInt('10000000000000'), // 0.00001 BNB
        bridge: BigInt('10000000000000'), // 0.00001 BNB
        swap: BigInt('10000000000000'), // 0.00001 BNB
      },
      // Polygon (chainId 137) - very low gas
      137: {
        simple: BigInt('1000000000000000'), // 0.001 MATIC
        'cross-chain': BigInt('2000000000000000'), // 0.002 MATIC
        bridge: BigInt('1500000000000000'), // 0.0015 MATIC
        swap: BigInt('1000000000000000'), // 0.001 MATIC
      },
      // Default for other EVM chains (moderate gas)
      default: {
        simple: BigInt('10000000000000000'), // 0.01 ETH
        'cross-chain': BigInt('20000000000000000'), // 0.02 ETH
        bridge: BigInt('15000000000000000'), // 0.015 ETH
        swap: BigInt('10000000000000000'), // 0.01 ETH
      },
    },
    tron: {
      // TRON uses SUN as smallest unit (1 TRX = 1,000,000 SUN)
      // Gas on TRON is paid via bandwidth/energy, but we reserve TRX for fees
      simple: BigInt(1_100_000), // 1.1 TRX
      'cross-chain': BigInt(1_100_000), // 1.1 TRX
      bridge: BigInt(1_100_000), // 1.1 TRX
      swap: BigInt(1_100_000), // 1.1 TRX (conservative reserve for swap transactions)
    },
    bitcoin: {
      simple: BigInt(50000), // 0.0005 BTC (50,000 sats)
      'cross-chain': BigInt(100000), // 0.001 BTC
      bridge: BigInt(75000), // 0.00075 BTC
      swap: BigInt(60000), // 0.0006 BTC
    },
  };

  /**
   * Record transaction cost data for adaptive learning
   */
  recordTransactionCost(data: {
    ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin';
    transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap';
    actualCost: bigint | string;
    balance: bigint | string;
    success: boolean;
    reserveUsed: bigint | string;
    chainId: string | number;
    errorCode?: string;
    errorMessage?: string;
  }): void {
    const key = this.getCategoryKey(data.ecosystem, data.transactionType);

    const costData: TransactionCostData = {
      timestamp: Date.now(),
      ecosystem: data.ecosystem,
      transactionType: data.transactionType,
      actualCost: BigInt(data.actualCost),
      balance: BigInt(data.balance),
      success: data.success,
      reserveUsed: BigInt(data.reserveUsed),
      chainId: data.chainId.toString(),
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
    };

    // Get or create history array for this category
    let history = this.costHistory.get(key);
    if (!history) {
      history = [];
      this.costHistory.set(key, history);
    }

    // Add new data point
    history.push(costData);

    // Trim to MAX_SAMPLES (keep most recent)
    if (history.length > this.MAX_SAMPLES) {
      history.shift();
    }

    this.logger.log(
      `Recorded transaction cost: ${data.ecosystem} ${data.transactionType}`,
      {
        actualCost: costData.actualCost.toString(),
        balance: costData.balance.toString(),
        success: data.success,
        reserveUsed: costData.reserveUsed.toString(),
        totalSamples: history.length,
      },
    );

    // If this was a failure due to insufficient funds, log warning
    if (
      !data.success &&
      (data.errorCode === '1' || data.errorMessage?.includes('Insufficient'))
    ) {
      this.logger.warn(
        `⚠️ Insufficient funds detected - reserve may need adjustment`,
        {
          ecosystem: data.ecosystem,
          transactionType: data.transactionType,
          reserveUsed: costData.reserveUsed.toString(),
          actualCost: costData.actualCost.toString(),
          deficit: (costData.actualCost - costData.reserveUsed).toString(),
        },
      );
    }
  }

  /**
   * Calculate adaptive gas reserve based on historical data
   *
   * Uses percentile-based approach (P95) for robustness:
   * - P95 means 95% of transactions will have enough reserve
   * - More reliable than average (not affected by outliers)
   * - Automatically adjusts as transaction costs change
   */
  calculateAdaptiveReserve(
    ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin',
    transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap',
    balance: bigint,
    chainId?: number,
  ): {
    reserve: bigint;
    strategy: 'adaptive' | 'fallback' | 'minimum';
    confidence: number;
    stats?: ReserveStatistics;
  } {
    const key = this.getCategoryKey(ecosystem, transactionType);
    const history = this.costHistory.get(key);

    // If insufficient data, use fallback
    if (!history || history.length < this.MIN_SAMPLES_FOR_ADAPTIVE) {
      const fallbackReserve = this.getFallbackReserve(
        ecosystem,
        transactionType,
        chainId,
      );

      this.logger.debug(`Using fallback reserve (insufficient data)`, {
        ecosystem,
        transactionType,
        samples: history?.length || 0,
        requiredSamples: this.MIN_SAMPLES_FOR_ADAPTIVE,
        fallbackReserve: fallbackReserve.toString(),
      });

      return {
        reserve: fallbackReserve,
        strategy: 'fallback',
        confidence: history
          ? history.length / this.MIN_SAMPLES_FOR_ADAPTIVE
          : 0,
      };
    }

    // Filter to recent successful transactions
    const recentSuccessful = history.filter(
      (tx) => tx.success && Date.now() - tx.timestamp < this.RECENT_WINDOW_MS,
    );

    // If not enough recent successful data, use all successful
    const dataSet =
      recentSuccessful.length >= 5
        ? recentSuccessful
        : history.filter((tx) => tx.success);

    if (dataSet.length < 5) {
      const fallbackReserve = this.getFallbackReserve(
        ecosystem,
        transactionType,
        chainId,
      );
      this.logger.debug(
        `Using fallback reserve (insufficient successful transactions)`,
        {
          ecosystem,
          transactionType,
          successfulTransactions: dataSet.length,
          fallbackReserve: fallbackReserve.toString(),
        },
      );

      return {
        reserve: fallbackReserve,
        strategy: 'fallback',
        confidence: dataSet.length / 5,
      };
    }

    // Calculate statistics from actual costs
    const stats = this.calculateStatistics(dataSet);

    // Use P95 (95th percentile) as the reserve
    // This ensures 95% of transactions will have sufficient funds
    let adaptiveReserve = stats.p95Cost;

    // Add safety buffer (10% of P95)
    const safetyBuffer = adaptiveReserve / BigInt(10);
    adaptiveReserve = adaptiveReserve + safetyBuffer;

    // Apply balance-based minimum (1% of balance)
    const balanceBasedMinimum = balance / BigInt(100);

    // Use the higher of adaptive reserve or balance-based minimum
    const finalReserve =
      adaptiveReserve > balanceBasedMinimum
        ? adaptiveReserve
        : balanceBasedMinimum;

    // Also apply absolute minimum from fallback
    const absoluteMinimum = this.getFallbackReserve(
      ecosystem,
      transactionType,
      chainId,
    );
    const reserve =
      finalReserve > absoluteMinimum ? finalReserve : absoluteMinimum;

    // Calculate confidence based on sample size and success rate
    const confidence = Math.min(
      (dataSet.length / this.MAX_SAMPLES) * stats.successRate,
      0.95, // Cap at 95%
    );

    this.logger.log(`Calculated adaptive reserve`, {
      ecosystem,
      transactionType,
      reserve: reserve.toString(),
      strategy: 'adaptive',
      confidence: confidence.toFixed(2),
      samples: dataSet.length,
      p95Cost: stats.p95Cost.toString(),
      avgCost: stats.averageCost.toString(),
      maxCost: stats.maxCost.toString(),
      successRate: stats.successRate.toFixed(2),
    });

    return {
      reserve,
      strategy: 'adaptive',
      confidence,
      stats,
    };
  }

  /**
   * Get statistics for a transaction category
   */
  getStatistics(
    ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin',
    transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap',
  ): ReserveStatistics | null {
    const key = this.getCategoryKey(ecosystem, transactionType);
    const history = this.costHistory.get(key);

    if (!history || history.length === 0) {
      return null;
    }

    const successfulTxs = history.filter((tx) => tx.success);
    return successfulTxs.length > 0
      ? this.calculateStatistics(successfulTxs)
      : null;
  }

  /**
   * Get all tracked categories with their sample counts
   */
  getTrackedCategories(): Array<{
    ecosystem: string;
    transactionType: string;
    totalSamples: number;
    successfulSamples: number;
    recentSamples: number;
  }> {
    const categories: Array<any> = [];

    for (const [key, history] of this.costHistory.entries()) {
      const [ecosystem, transactionType] = key.split(':');
      const successful = history.filter((tx) => tx.success).length;
      const recent = history.filter(
        (tx) => Date.now() - tx.timestamp < this.RECENT_WINDOW_MS,
      ).length;

      categories.push({
        ecosystem,
        transactionType,
        totalSamples: history.length,
        successfulSamples: successful,
        recentSamples: recent,
      });
    }

    return categories;
  }

  /**
   * Reset tracking data for a specific category or all categories
   */
  resetTracking(ecosystem?: string, transactionType?: string): void {
    if (ecosystem && transactionType) {
      const key = this.getCategoryKey(
        ecosystem as 'solana' | 'evm' | 'bitcoin',
        transactionType as 'simple' | 'cross-chain' | 'bridge' | 'swap',
      );
      this.costHistory.delete(key);
      this.logger.log(`Reset tracking for ${key}`);
    } else {
      this.costHistory.clear();
      this.logger.log('Reset all tracking data');
    }
  }

  /**
   * Calculate comprehensive statistics from transaction data
   */
  private calculateStatistics(data: TransactionCostData[]): ReserveStatistics {
    // Sort by actual cost
    const sortedCosts = data
      .map((tx) => tx.actualCost)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const total = sortedCosts.length;
    const sum = sortedCosts.reduce((acc, cost) => acc + cost, BigInt(0));
    const average = sum / BigInt(total);

    // Calculate percentiles
    const p50Index = Math.floor(total * 0.5);
    const p75Index = Math.floor(total * 0.75);
    const p90Index = Math.floor(total * 0.9);
    const p95Index = Math.floor(total * 0.95);

    const successCount = data.filter((tx) => tx.success).length;

    return {
      averageCost: average,
      maxCost: sortedCosts[total - 1],
      minCost: sortedCosts[0],
      recentSamples: total,
      successRate: successCount / total,
      lastUpdated: Date.now(),
      p50Cost: sortedCosts[p50Index],
      p75Cost: sortedCosts[p75Index],
      p90Cost: sortedCosts[p90Index],
      p95Cost: sortedCosts[p95Index],
    };
  }

  /**
   * Get category key for storage
   */
  private getCategoryKey(
    ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin',
    transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap',
  ): string {
    return `${ecosystem}:${transactionType}`;
  }

  /**
   * Get fallback reserve for a category
   */
  private getFallbackReserve(
    ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin',
    transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap',
    chainId?: number,
  ): bigint {
    if (ecosystem === 'evm' && chainId !== undefined) {
      const chainReserves =
        this.FALLBACK_RESERVES.evm[chainId] ||
        this.FALLBACK_RESERVES.evm.default;
      return chainReserves[transactionType];
    }
    return this.FALLBACK_RESERVES[ecosystem][transactionType];
  }
}
