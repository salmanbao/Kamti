import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Historical Swap Record
 * Stored data about past swap executions
 */
interface SwapRecord {
  executionId: string;
  timestamp: Date;
  aggregator: string;
  sourceChain: number | string;
  destChain: number | string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string;
  gasUsed?: string;
  gasCostUsd?: string;
  protocolFeesUsd?: string;
  totalCostUsd?: string;
  executionTimeSeconds: number;
  priceImpact: number;
  slippage: number;
  success: boolean;
  failureReason?: string;
  qualityScore?: number;
}

/**
 * Aggregator Statistics
 */
interface AggregatorStats {
  aggregator: string;
  totalSwaps: number;
  successfulSwaps: number;
  failedSwaps: number;
  totalVolumeUsd: string;
  averageExecutionTime: number;
  averageGasCostUsd: string;
  averageProtocolFeePercent: number;
  averagePriceImpact: number;
  averageSlippage: number;
  lastUpdated: Date;
}

/**
 * Phase 4: Swap Analytics Service
 * Tracks and analyzes historical swap data for insights and comparisons
 */
@Injectable()
export class SwapAnalyticsService {
  constructor(private readonly logger: WinstonLoggerService) {
    this.logger.setContext(SwapAnalyticsService.name);
  }

  // In-memory storage (in production, use Redis or Database)
  private swapHistory: Map<string, SwapRecord> = new Map();
  private aggregatorStats: Map<string, AggregatorStats> = new Map();

  // Configuration
  private readonly MAX_HISTORY_SIZE = 10000; // Keep last 10k swaps
  private readonly STATS_UPDATE_INTERVAL = 1000 * 60 * 5; // 5 minutes

  /**
   * Record a completed swap execution
   */
  recordSwap(record: SwapRecord): void {
    try {
      // Store swap record
      this.swapHistory.set(record.executionId, record);

      // Limit history size (FIFO)
      if (this.swapHistory.size > this.MAX_HISTORY_SIZE) {
        const firstKey = this.swapHistory.keys().next().value;
        this.swapHistory.delete(firstKey);
      }

      // Update aggregator statistics
      this.updateAggregatorStats(record);

      this.logger.debug(
        `Recorded swap: ${record.executionId} via ${record.aggregator}`,
      );
    } catch (error) {
      this.logger.error(`Failed to record swap: ${error.message}`);
    }
  }

  /**
   * Update aggregator statistics with new swap data
   */
  private updateAggregatorStats(record: SwapRecord): void {
    const stats = this.aggregatorStats.get(record.aggregator) || {
      aggregator: record.aggregator,
      totalSwaps: 0,
      successfulSwaps: 0,
      failedSwaps: 0,
      totalVolumeUsd: '0',
      averageExecutionTime: 0,
      averageGasCostUsd: '0',
      averageProtocolFeePercent: 0,
      averagePriceImpact: 0,
      averageSlippage: 0,
      lastUpdated: new Date(),
    };

    // Update counters
    stats.totalSwaps += 1;
    if (record.success) {
      stats.successfulSwaps += 1;
    } else {
      stats.failedSwaps += 1;
    }

    // Update averages (running average)
    const n = stats.totalSwaps;
    stats.averageExecutionTime =
      (stats.averageExecutionTime * (n - 1) + record.executionTimeSeconds) / n;

    if (record.gasCostUsd) {
      const newGasCost = parseFloat(record.gasCostUsd);
      const oldGasCost = parseFloat(stats.averageGasCostUsd);
      stats.averageGasCostUsd = (
        (oldGasCost * (n - 1) + newGasCost) /
        n
      ).toFixed(2);
    }

    stats.averagePriceImpact =
      (stats.averagePriceImpact * (n - 1) + record.priceImpact) / n;

    stats.averageSlippage =
      (stats.averageSlippage * (n - 1) + record.slippage) / n;

    stats.lastUpdated = new Date();

    this.aggregatorStats.set(record.aggregator, stats);
  }

  /**
   * Get aggregator performance statistics
   */
  getAggregatorStats(aggregator: string): AggregatorStats | null {
    return this.aggregatorStats.get(aggregator) || null;
  }

  /**
   * Get all aggregator statistics
   */
  getAllAggregatorStats(): AggregatorStats[] {
    return Array.from(this.aggregatorStats.values());
  }

  /**
   * Get success rate for an aggregator (percentage)
   */
  getSuccessRate(aggregator: string): number {
    const stats = this.aggregatorStats.get(aggregator);
    if (!stats || stats.totalSwaps === 0) {
      return 90; // Default assumption
    }
    return (stats.successfulSwaps / stats.totalSwaps) * 100;
  }

  /**
   * Get average execution time for an aggregator
   */
  getAverageExecutionTime(aggregator: string): number {
    const stats = this.aggregatorStats.get(aggregator);
    return stats?.averageExecutionTime || 30; // Default 30 seconds
  }

  /**
   * Get average gas cost for an aggregator
   */
  getAverageGasCost(aggregator: string): string {
    const stats = this.aggregatorStats.get(aggregator);
    return stats?.averageGasCostUsd || '10.00';
  }

  /**
   * Compare aggregator costs
   */
  compareAggregatorCosts(
    aggregator: string,
  ): 'cheaper' | 'average' | 'expensive' {
    const allStats = this.getAllAggregatorStats();
    if (allStats.length === 0) return 'average';

    const stats = this.aggregatorStats.get(aggregator);
    if (!stats) return 'average';

    const avgCost = parseFloat(stats.averageGasCostUsd);
    const costs = allStats.map((s) => parseFloat(s.averageGasCostUsd));
    const meanCost = costs.reduce((a, b) => a + b, 0) / costs.length;

    if (avgCost < meanCost * 0.9) return 'cheaper';
    if (avgCost > meanCost * 1.1) return 'expensive';
    return 'average';
  }

  /**
   * Get similar historical swaps for comparison
   */
  getSimilarSwaps(params: {
    inputToken: string;
    outputToken: string;
    chainId: number | string;
    limit?: number;
  }): SwapRecord[] {
    const { inputToken, outputToken, chainId, limit = 20 } = params;

    const similar = Array.from(this.swapHistory.values())
      .filter(
        (record) =>
          record.inputToken.toLowerCase() === inputToken.toLowerCase() &&
          record.outputToken.toLowerCase() === outputToken.toLowerCase() &&
          record.sourceChain === chainId &&
          record.success,
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);

    return similar;
  }

  /**
   * Calculate performance percentile for a swap
   * Returns 0-100 where 100 = best performance
   */
  calculatePerformancePercentile(params: {
    inputToken: string;
    outputToken: string;
    chainId: number | string;
    totalCostUsd: string;
  }): number {
    const similar = this.getSimilarSwaps({
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      chainId: params.chainId,
      limit: 100,
    });

    if (similar.length === 0) return 50; // No data, assume average

    const costs = similar
      .map((s) => parseFloat(s.totalCostUsd || '0'))
      .filter((c) => c > 0)
      .sort((a, b) => a - b); // Lower cost = better

    if (costs.length === 0) return 50;

    const yourCost = parseFloat(params.totalCostUsd);
    const betterCount = costs.filter((c) => c < yourCost).length;

    // Percentile calculation (lower cost = higher percentile)
    return Math.round((betterCount / costs.length) * 100);
  }

  /**
   * Get average cost for similar swaps
   */
  getAverageCostForSimilarSwaps(params: {
    inputToken: string;
    outputToken: string;
    chainId: number | string;
  }): string {
    const similar = this.getSimilarSwaps(params);

    if (similar.length === 0) return '0';

    const costs = similar
      .map((s) => parseFloat(s.totalCostUsd || '0'))
      .filter((c) => c > 0);

    if (costs.length === 0) return '0';

    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    return avgCost.toFixed(2);
  }

  /**
   * Get best performing aggregator for a token pair
   */
  getBestAggregatorForPair(params: {
    inputToken: string;
    outputToken: string;
    chainId: number | string;
  }): { aggregator: string; reason: string } | null {
    const similar = this.getSimilarSwaps(params);

    if (similar.length === 0) return null;

    // Group by aggregator
    const byAggregator = new Map<string, SwapRecord[]>();
    similar.forEach((record) => {
      const records = byAggregator.get(record.aggregator) || [];
      records.push(record);
      byAggregator.set(record.aggregator, records);
    });

    // Calculate scores for each aggregator
    const scores = Array.from(byAggregator.entries()).map(
      ([aggregator, records]) => {
        const avgCost =
          records.reduce(
            (sum, r) => sum + parseFloat(r.totalCostUsd || '0'),
            0,
          ) / records.length;
        const avgImpact =
          records.reduce((sum, r) => sum + r.priceImpact, 0) / records.length;
        const avgTime =
          records.reduce((sum, r) => sum + r.executionTimeSeconds, 0) /
          records.length;

        // Lower is better for cost, impact, and time
        const costScore = 100 - (avgCost / 100) * 100; // Normalize assuming max $100
        const impactScore = 100 - avgImpact * 10; // 10% impact = 0 score
        const timeScore = 100 - (avgTime / 60) * 100; // Normalize to 60 seconds

        const overallScore =
          costScore * 0.4 + impactScore * 0.4 + timeScore * 0.2;

        return { aggregator, score: overallScore, avgCost, avgImpact, avgTime };
      },
    );

    // Get best aggregator
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];

    if (!best) return null;

    return {
      aggregator: best.aggregator,
      reason: `Lowest average cost ($${best.avgCost.toFixed(2)}) and price impact (${best.avgImpact.toFixed(2)}%)`,
    };
  }

  /**
   * Get performance trend for an aggregator
   */
  getPerformanceTrend(
    aggregator: string,
    periodDays: number = 7,
  ): {
    successRateChange: number;
    costChange: number;
    qualityChange: number;
  } {
    const cutoffDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const allRecords = Array.from(this.swapHistory.values()).filter(
      (r) => r.aggregator === aggregator,
    );

    const recentRecords = allRecords.filter((r) => r.timestamp >= cutoffDate);
    const olderRecords = allRecords.filter((r) => r.timestamp < cutoffDate);

    if (recentRecords.length === 0 || olderRecords.length === 0) {
      return { successRateChange: 0, costChange: 0, qualityChange: 0 };
    }

    // Calculate success rate change
    const recentSuccessRate =
      (recentRecords.filter((r) => r.success).length / recentRecords.length) *
      100;
    const olderSuccessRate =
      (olderRecords.filter((r) => r.success).length / olderRecords.length) *
      100;
    const successRateChange = recentSuccessRate - olderSuccessRate;

    // Calculate cost change
    const recentAvgCost =
      recentRecords.reduce(
        (sum, r) => sum + parseFloat(r.totalCostUsd || '0'),
        0,
      ) / recentRecords.length;
    const olderAvgCost =
      olderRecords.reduce(
        (sum, r) => sum + parseFloat(r.totalCostUsd || '0'),
        0,
      ) / olderRecords.length;
    const costChange =
      olderAvgCost > 0
        ? ((recentAvgCost - olderAvgCost) / olderAvgCost) * 100
        : 0;

    // Calculate quality change (based on price impact and slippage)
    const recentQuality =
      recentRecords.reduce((sum, r) => sum + (r.qualityScore || 0), 0) /
      recentRecords.length;
    const olderQuality =
      olderRecords.reduce((sum, r) => sum + (r.qualityScore || 0), 0) /
      olderRecords.length;
    const qualityChange = recentQuality - olderQuality;

    return {
      successRateChange: parseFloat(successRateChange.toFixed(2)),
      costChange: parseFloat(costChange.toFixed(2)),
      qualityChange: parseFloat(qualityChange.toFixed(2)),
    };
  }

  /**
   * Clear all analytics data (for testing)
   */
  clearAllData(): void {
    this.swapHistory.clear();
    this.aggregatorStats.clear();
    this.logger.log('Analytics data cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { historySize: number; aggregatorsTracked: number } {
    return {
      historySize: this.swapHistory.size,
      aggregatorsTracked: this.aggregatorStats.size,
    };
  }
}
