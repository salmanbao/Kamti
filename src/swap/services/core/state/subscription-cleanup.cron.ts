import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TransactionMonitorGateway } from '@swap/services/blockchain/monitoring/transaction-monitor.gateway';
import { DestinationFundDetectorService } from './destination-fund-detector.service';
import { BridgeStatusTrackerService } from './bridge-status-tracker.service';

/**
 * Subscription Cleanup Cron Service
 *
 * Periodically cleans up stale subscriptions and tracking state to prevent memory leaks.
 *
 * Cleanup Targets:
 * 1. WebSocket subscriptions for completed/failed executions
 * 2. Destination fund detector WebSocket subscriptions
 * 3. Bridge tracking state for completed/timed-out executions
 *
 * Schedule: Every 30 minutes
 */
@Injectable()
export class SubscriptionCleanupCronService {
  private readonly logger = new Logger(SubscriptionCleanupCronService.name);

  constructor(
    private readonly transactionMonitor: TransactionMonitorGateway,
    private readonly destinationFundDetector: DestinationFundDetectorService,
    private readonly bridgeStatusTracker: BridgeStatusTrackerService,
  ) {}

  /**
   * Run cleanup every 30 minutes
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async cleanupStaleSubscriptions() {
    this.logger.log('Starting stale subscription cleanup');

    const startTime = Date.now();

    try {
      // 1. Cleanup WebSocket subscriptions in destination fund detector
      this.destinationFundDetector.cleanupStaleSubscriptions();
      this.logger.log('Cleaned up destination fund detector subscriptions');

      // 2. Cleanup stale WebSocket connections in transaction monitor
      const cleanedMonitorSubs = this.cleanupTransactionMonitorSubscriptions();
      this.logger.log(
        `Cleaned up ${cleanedMonitorSubs} stale transaction monitor subscriptions`,
      );

      // 3. Cleanup stale bridge tracking state
      const cleanedTrackers = this.cleanupStaleBridgeTrackers();
      this.logger.log(`Cleaned up ${cleanedTrackers} stale bridge trackers`);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Subscription cleanup completed in ${duration}ms (${cleanedMonitorSubs} monitor subs, ${cleanedTrackers} bridge trackers)`,
      );
    } catch (error) {
      this.logger.error('Error during subscription cleanup', error);
    }
  }

  /**
   * Cleanup stale transaction monitor subscriptions
   *
   * Removes subscriptions where all connected clients have disconnected
   * or the execution is very old (>24 hours).
   *
   * @returns Number of subscriptions cleaned up
   */
  private cleanupTransactionMonitorSubscriptions(): number {
    let cleanedCount = 0;

    try {
      // Access the activeSubscriptions map from transaction monitor
      const activeSubscriptions = (this.transactionMonitor as any)
        .activeSubscriptions as Map<string, Set<string>>;

      if (!activeSubscriptions) {
        this.logger.warn('activeSubscriptions map not found in transaction monitor');
        return 0;
      }

      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      for (const [executionId, socketIds] of activeSubscriptions.entries()) {
        // Remove if no active socket connections
        if (socketIds.size === 0) {
          activeSubscriptions.delete(executionId);
          cleanedCount++;
          this.logger.debug(
            `Removed subscription for ${executionId}: no active clients`,
          );
          continue;
        }

        // Check if execution is very old (parse timestamp from executionId if possible)
        // executionId format typically includes timestamp
        const createdAt = this.extractTimestampFromExecutionId(executionId);
        if (createdAt && now - createdAt > maxAge) {
          activeSubscriptions.delete(executionId);
          cleanedCount++;
          this.logger.debug(
            `Removed subscription for ${executionId}: execution too old (>24h)`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Error cleaning up transaction monitor subscriptions',
        error,
      );
    }

    return cleanedCount;
  }

  /**
   * Cleanup stale bridge tracking state
   *
   * Removes tracker state for executions that are:
   * - Already stopped
   * - Very old (>6 hours) with no recent activity
   *
   * @returns Number of trackers cleaned up
   */
  private cleanupStaleBridgeTrackers(): number {
    let cleanedCount = 0;

    try {
      // Access the activeTrackers map from bridge status tracker
      const activeTrackers = (this.bridgeStatusTracker as any)
        .activeTrackers as Map<string, any>;

      if (!activeTrackers) {
        this.logger.warn('activeTrackers map not found in bridge status tracker');
        return 0;
      }

      const now = Date.now();
      const maxAge = 6 * 60 * 60 * 1000; // 6 hours

      for (const [executionId, trackerState] of activeTrackers.entries()) {
        // Remove if already stopped
        if (trackerState.stopped) {
          activeTrackers.delete(executionId);
          cleanedCount++;
          this.logger.debug(
            `Removed tracker for ${executionId}: already stopped`,
          );
          continue;
        }

        // Remove if tracking for too long (>6 hours)
        const age = now - trackerState.startTime;
        if (age > maxAge) {
          // Clean up any pending timers
          if (trackerState.timeoutHandle) {
            clearTimeout(trackerState.timeoutHandle);
          }
          if (trackerState.pollHandle) {
            clearTimeout(trackerState.pollHandle);
          }

          activeTrackers.delete(executionId);
          cleanedCount++;
          this.logger.warn(
            `Removed tracker for ${executionId}: tracking too long (${Math.round(age / 1000 / 60)} minutes)`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Error cleaning up bridge trackers', error);
    }

    return cleanedCount;
  }

  /**
   * Extract timestamp from execution ID
   *
   * Attempts to parse timestamp from common executionId formats:
   * - exec_timestamp_randomId
   * - timestamp_randomId
   * - UUID v1 (contains timestamp)
   *
   * @param executionId - Execution ID
   * @returns Timestamp in milliseconds or null
   */
  private extractTimestampFromExecutionId(executionId: string): number | null {
    try {
      // Try format: exec_1234567890123_abc
      const timestampMatch = executionId.match(/(\d{13})/);
      if (timestampMatch) {
        const timestamp = parseInt(timestampMatch[1], 10);
        if (!isNaN(timestamp) && timestamp > 1000000000000) {
          return timestamp;
        }
      }

      // Try UUID v1 timestamp extraction
      if (executionId.includes('-')) {
        const parts = executionId.split('-');
        if (parts.length === 5) {
          // UUID v1 format: time_low-time_mid-time_hi_and_version-clock_seq-node
          const timeLow = parseInt(parts[0], 16);
          const timeMid = parseInt(parts[1], 16);
          const timeHi = parseInt(parts[2].substring(1), 16); // Remove version nibble

          if (!isNaN(timeLow) && !isNaN(timeMid) && !isNaN(timeHi)) {
            // UUID v1 timestamp is in 100-nanosecond intervals since Oct 15, 1582
            const uuidTimestamp =
              (BigInt(timeHi) << BigInt(48)) |
              (BigInt(timeMid) << BigInt(32)) |
              BigInt(timeLow);
            // Convert to milliseconds since Unix epoch
            const unixTimestamp =
              Number(uuidTimestamp / BigInt(10000)) - 12219292800000;
            return unixTimestamp;
          }
        }
      }
    } catch (error) {
      // Ignore parsing errors
    }

    return null;
  }

  /**
   * Manual trigger for cleanup (for testing or admin endpoints)
   */
  async triggerManualCleanup(): Promise<{
    monitorSubscriptions: number;
    bridgeTrackers: number;
  }> {
    this.logger.log('Manual cleanup triggered');

    this.destinationFundDetector.cleanupStaleSubscriptions();
    const monitorSubscriptions = this.cleanupTransactionMonitorSubscriptions();
    const bridgeTrackers = this.cleanupStaleBridgeTrackers();

    return {
      monitorSubscriptions,
      bridgeTrackers,
    };
  }
}
