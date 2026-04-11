import { Injectable, Logger } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Tracks historical gas estimation accuracy to improve future estimates
 * Applies dynamic correction factors based on aggregator performance
 */
@Injectable()
export class GasEstimationTrackerService {
  // Historical data storage (in-memory, could be persisted to Redis/DB)
  private gasEstimationHistory: Map<string, GasEstimationRecord[]> = new Map();

  // Correction factors by aggregator
  private correctionFactors: Map<string, number> = new Map([
    ['0x', 0.7], // 0x typically over-estimates by ~30%
    ['odos', 0.75], // Odos over-estimates by ~25%
    ['1inch', 0.8], // 1inch over-estimates by ~20%
    ['default', 0.75], // Default correction factor
  ]);

  // Maximum records to keep per aggregator
  private readonly MAX_HISTORY_SIZE = 100;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.winstonLogger.setContext('GasEstimationTrackerService');
  }

  /**
   * Record a gas estimation vs actual usage
   */
  recordGasUsage(params: {
    aggregator: string;
    chainId: number;
    estimatedGas: string | number;
    actualGasUsed: string | number;
    txHash?: string;
  }): void {
    const { aggregator, chainId, estimatedGas, actualGasUsed, txHash } = params;

    const estimated = BigInt(estimatedGas);
    const actual = BigInt(actualGasUsed);

    // Calculate accuracy ratio
    const accuracyRatio = Number(actual) / Number(estimated);

    const record: GasEstimationRecord = {
      aggregator,
      chainId,
      estimatedGas: estimated.toString(),
      actualGasUsed: actual.toString(),
      accuracyRatio,
      txHash,
      timestamp: Date.now(),
    };

    // Get or create history for this aggregator
    const key = `${aggregator}-${chainId}`;
    if (!this.gasEstimationHistory.has(key)) {
      this.gasEstimationHistory.set(key, []);
    }

    const history = this.gasEstimationHistory.get(key)!;
    history.push(record);

    // Trim history if too large
    if (history.length > this.MAX_HISTORY_SIZE) {
      history.shift(); // Remove oldest
    }

    // Audit log gas estimation record
    this.winstonLogger.audit('GAS_ESTIMATION_RECORDED', {
      aggregator,
      chainId,
      estimatedGas: estimated.toString(),
      actualGasUsed: actual.toString(),
      accuracyRatio,
      accuracyPercent: (accuracyRatio * 100).toFixed(1),
      txHash,
      totalRecords: history.length,
      timestamp: new Date().toISOString(),
    });

    // Update correction factor based on recent history
    this.updateCorrectionFactor(aggregator, chainId);

    this.winstonLogger.debug(
      `📊 Gas estimation recorded: ${aggregator} estimated ${estimated}, actual ${actual} (${(accuracyRatio * 100).toFixed(1)}%)`,
    );
  }

  /**
   * Get corrected gas estimate based on historical data
   */
  getCorrectedGasEstimate(params: {
    aggregator: string;
    chainId: number;
    estimatedGas: string | number;
  }): string {
    const { aggregator, chainId, estimatedGas } = params;

    const factor = this.getCorrectionFactor(aggregator, chainId);
    const estimated = BigInt(estimatedGas);
    const corrected = (estimated * BigInt(Math.floor(factor * 1000))) / 1000n;

    this.winstonLogger.debug(
      `🔧 Gas correction: ${aggregator} ${estimated} -> ${corrected} (${factor.toFixed(2)}x factor)`,
    );

    return corrected.toString();
  }

  /**
   * Get correction factor for an aggregator
   */
  private getCorrectionFactor(aggregator: string, chainId: number): number {
    const key = `${aggregator}-${chainId}`;

    // Check if we have calculated factor for this specific aggregator-chain combo
    if (this.correctionFactors.has(key)) {
      return this.correctionFactors.get(key)!;
    }

    // Fall back to aggregator-wide factor
    if (this.correctionFactors.has(aggregator)) {
      return this.correctionFactors.get(aggregator)!;
    }

    // Use default
    return this.correctionFactors.get('default')!;
  }

  /**
   * Update correction factor based on recent history
   */
  private updateCorrectionFactor(aggregator: string, chainId: number): void {
    const key = `${aggregator}-${chainId}`;
    const history = this.gasEstimationHistory.get(key);

    if (!history || history.length < 10) {
      return; // Need at least 10 samples
    }

    // Calculate average accuracy ratio from recent history
    const recent = history.slice(-20); // Last 20 transactions
    const avgRatio =
      recent.reduce((sum, r) => sum + r.accuracyRatio, 0) / recent.length;

    // Update correction factor (weighted moving average)
    const currentFactor = this.getCorrectionFactor(aggregator, chainId);
    const newFactor = currentFactor * 0.7 + avgRatio * 0.3; // 70% old, 30% new

    // Clamp between 0.5 and 1.2 (don't over-correct)
    const clampedFactor = Math.max(0.5, Math.min(1.2, newFactor));

    this.correctionFactors.set(key, clampedFactor);

    // Audit log correction factor update
    this.winstonLogger.audit('GAS_CORRECTION_FACTOR_UPDATED', {
      aggregator,
      chainId,
      oldFactor: currentFactor.toFixed(3),
      newFactor: clampedFactor.toFixed(3),
      avgAccuracyRatio: avgRatio.toFixed(3),
      sampleSize: recent.length,
      timestamp: new Date().toISOString(),
    });

    this.winstonLogger.log(
      `🔧 Updated correction factor for ${aggregator}-${chainId}: ${clampedFactor.toFixed(3)}x (avg ratio: ${avgRatio.toFixed(3)})`,
    );
  }

  /**
   * Get gas estimation metrics for reporting
   */
  getMetrics(aggregator?: string): GasEstimationMetrics {
    const allRecords: GasEstimationRecord[] = [];

    if (aggregator) {
      // Get records for specific aggregator across all chains
      for (const [key, records] of this.gasEstimationHistory.entries()) {
        if (key.startsWith(aggregator)) {
          allRecords.push(...records);
        }
      }
    } else {
      // Get all records
      for (const records of this.gasEstimationHistory.values()) {
        allRecords.push(...records);
      }
    }

    if (allRecords.length === 0) {
      return {
        totalRecords: 0,
        avgAccuracyRatio: 1.0,
        avgOverestimation: 0,
        avgUnderestimation: 0,
      };
    }

    const avgRatio =
      allRecords.reduce((sum, r) => sum + r.accuracyRatio, 0) /
      allRecords.length;

    const overestimated = allRecords.filter((r) => r.accuracyRatio < 1.0);
    const underestimated = allRecords.filter((r) => r.accuracyRatio > 1.0);

    const avgOver =
      overestimated.length > 0
        ? overestimated.reduce((sum, r) => sum + (1 - r.accuracyRatio), 0) /
          overestimated.length
        : 0;

    const avgUnder =
      underestimated.length > 0
        ? underestimated.reduce((sum, r) => sum + (r.accuracyRatio - 1), 0) /
          underestimated.length
        : 0;

    return {
      totalRecords: allRecords.length,
      avgAccuracyRatio: avgRatio,
      avgOverestimation: avgOver,
      avgUnderestimation: avgUnder,
    };
  }

  /**
   * Clear history (for testing or maintenance)
   */
  clearHistory(): void {
    this.gasEstimationHistory.clear();
    this.winstonLogger.log('🧹 Gas estimation history cleared');
  }
}

interface GasEstimationRecord {
  aggregator: string;
  chainId: number;
  estimatedGas: string;
  actualGasUsed: string;
  accuracyRatio: number;
  txHash?: string;
  timestamp: number;
}

interface GasEstimationMetrics {
  totalRecords: number;
  avgAccuracyRatio: number;
  avgOverestimation: number;
  avgUnderestimation: number;
}
