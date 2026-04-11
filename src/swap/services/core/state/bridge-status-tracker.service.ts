import { Injectable } from '@nestjs/common';
import { ExecutionStateService } from './execution-state.service';
import { RubicService } from '@swap/services/providers/meta/rubic.service';
import { SymbiosisService } from '@swap/services/providers/meta/symbiosis.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { RouteQuote } from '@swap/models/ports';

type BridgeStatus =
  | 'initiated'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'reverted';

interface TrackerState {
  stopped: boolean;
  startTime: number;
  pollAttempts: number;
  timeoutHandle?: NodeJS.Timeout;
  pollHandle?: NodeJS.Timeout;
}

@Injectable()
export class BridgeStatusTrackerService {
  private readonly activeTrackers = new Map<string, TrackerState>();
  private readonly DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
  private readonly MAX_ERROR_COUNT = 5;
  private readonly INITIAL_POLL_DELAY_MS = 30000; // 30 seconds
  private readonly MAX_POLL_ATTEMPTS = 120; // Maximum 120 attempts (with 5min backoff = 10 hours max)

  constructor(
    private readonly stateService: ExecutionStateService,
    private readonly rubicService: RubicService,
    private readonly symbiosisService: SymbiosisService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(BridgeStatusTrackerService.name);
  }

  /**
   * Start background tracking of cross-chain bridge status for an execution.
   * Currently supports Rubic provider; others default to static pending status.
   * @param timeoutMs - Optional custom timeout in milliseconds (defaults to 60 minutes)
   */
  startTracking(
    executionId: string,
    route: RouteQuote,
    sourceTxHash: string,
    timeoutMs?: number,
  ): void {
    if (!executionId || !route || !sourceTxHash) return;

    // Avoid duplicate trackers per executionId
    if (this.activeTrackers.has(executionId)) {
      this.logger.warn(
        `Tracker already exists for ${executionId}, skipping duplicate`,
      );
      return;
    }

    const trackerState: TrackerState = {
      stopped: false,
      startTime: Date.now(),
      pollAttempts: 0,
    };
    this.activeTrackers.set(executionId, trackerState);

    // Set up timeout enforcement
    const maxDurationMs = timeoutMs || this.DEFAULT_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      this.handleTimeout(executionId, maxDurationMs);
    }, maxDurationMs);
    trackerState.timeoutHandle = timeoutHandle;

    this.logger.log(
      `Started bridge tracking for ${executionId} with ${maxDurationMs / 1000}s timeout`,
    );

    const providerRef: any = route.providerRef || {};
    const aggregator: string = (providerRef.aggregator || '')
      .toString()
      .toLowerCase();

    // Support both Rubic and Symbiosis providers
    if (aggregator !== 'rubic' && aggregator !== 'symbiosis') {
      this.logger.debug(
        `Bridge tracking not implemented for aggregator=${aggregator}. Supported: rubic, symbiosis`,
      );
      // Clean up tracker state since we won't be tracking
      this.cleanupTracker(executionId);
      return;
    }

    this.logger.debug(
      `Starting ${aggregator} bridge tracking for ${executionId}`,
    );

    // Progressive polling with backoff ceilings
    const poll = async (attempt: number) => {
      if (trackerState.stopped) return;

      try {
        // Call appropriate provider's status API
        let status: any;
        
        if (aggregator === 'rubic') {
          status = await this.rubicService.getBridgeStatus(
            sourceTxHash,
            providerRef,
          );
        } else if (aggregator === 'symbiosis') {
          // Get source chain ID from providerRef or execution snapshot
          const currentSnapshot =
            await this.stateService.getExecutionSnapshot(executionId);
          const sourceChainId = 
            providerRef.fromChainId || 
            currentSnapshot?.source?.chainId ||
            undefined;

          const symbiosisStatus: any = await this.symbiosisService.status(
            sourceTxHash,
            sourceChainId,
          );

          // Convert Symbiosis response to Rubic-compatible format
          // Symbiosis returns {status, txHash, message, timestamp, steps}
          status = {
            status: symbiosisStatus.status,
            destTxHash: symbiosisStatus.txHash,
            statusUrl: undefined,
            etaMs: undefined,
            destChainId: providerRef.toChainId,
          };
        }

        this.logger.debug(
          `${aggregator} status update: ${status.status} | destTx=${status.destTxHash || 'pending'}`,
        );

        const currentSnapshot =
          await this.stateService.getExecutionSnapshot(executionId);
        const currentBridge: any = currentSnapshot?.bridge || {};

        // Calculate progress percentage
        let progressPercentage = 0;
        if (status.status === 'completed') {
          progressPercentage = 100;
        } else if (status.status === 'reverted') {
          progressPercentage = 100; // Reverted is a terminal state (funds returned)
        } else if (status.status === 'unknown') {
          // Handle Symbiosis 'unknown' status (likely still pending or error)
          progressPercentage = 5;
        } else if (status.status === 'in_progress') {
          const startedAt = currentBridge.startedAt || Date.now();
          const etaMs = status.etaMs || currentBridge.etaMs || 30 * 60 * 1000;
          const elapsed = Date.now() - startedAt;
          progressPercentage = Math.min(
            95,
            Math.round((elapsed / etaMs) * 100),
          );
        } else if (status.status === 'pending') {
          progressPercentage = 10;
        }

        // Update snapshot with richer details
        this.stateService.updateExecutionSnapshot(executionId, {
          bridge: {
            ...currentBridge,
            status: status.status as BridgeStatus,
            statusUrl: status.statusUrl,
            etaMs: status.etaMs,
            destChainId: status.destChainId,
            destTxHash: status.destTxHash,
            toAmount: (status as any).toAmount,
            toAmountWei: (status as any).toAmountWei,
            destExplorerUrl:
              status.destTxHash && status.destChainId
                ? undefined // let status endpoint compute explorer dynamically
                : currentBridge.destExplorerUrl,
            lastCheckedAt: Date.now(),
            checkCount: (currentBridge.checkCount || 0) + 1,
            errorCount: 0, // Reset on success
            progressPercentage,
          },
          overall:
            status.status === 'completed'
              ? 'SUCCESS'
              : status.status === 'failed'
                ? 'FAILED'
                : status.status === 'reverted'
                  ? 'REVERTED'
                  : 'IN_PROGRESS',
        } as any);

        // Add status history entry
        this.stateService.addStatusHistory(
          executionId,
          status.status,
          status.destTxHash ? `Dest tx: ${status.destTxHash}` : undefined,
        );

        // Stop conditions
        if (
          status.status === 'completed' ||
          status.status === 'failed' ||
          status.status === 'reverted'
        ) {
          this.logger.log(
            `${aggregator} bridge tracking finished for ${executionId} with status=${status.status}`,
          );
          this.cleanupTracker(executionId);
          return;
        }

        // Continue polling for unknown status (Symbiosis error case)
        if (status.status === 'unknown') {
          this.logger.warn(
            `${aggregator} returned unknown status for ${executionId}, will retry`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `${aggregator} bridge status poll error for ${executionId}: ${err?.message || err}`,
        );

        // Track errors in snapshot
        const currentSnapshot =
          await this.stateService.getExecutionSnapshot(executionId);
        const currentBridge: any = currentSnapshot?.bridge || {};
        
        // Handle Symbiosis-specific exceptions
        const isSymbiosisError = aggregator === 'symbiosis';
        const errorDetails: any = {
          lastCheckedAt: Date.now(),
          errorCount: (currentBridge.errorCount || 0) + 1,
          lastError: err?.message || String(err),
        };

        // Add Symbiosis-specific error context
        if (isSymbiosisError && err.response) {
          errorDetails.httpStatus = err.response.status;
          errorDetails.apiError = err.response.data;
        }

        this.stateService.updateExecutionSnapshot(executionId, {
          bridge: {
            ...currentBridge,
            ...errorDetails,
          },
        } as any);

        // Stop after too many consecutive errors
        if ((currentBridge.errorCount || 0) >= this.MAX_ERROR_COUNT) {
          this.logger.error(
            `${aggregator} bridge tracking stopped for ${executionId} due to ${this.MAX_ERROR_COUNT} consecutive errors`,
          );
          this.cleanupTracker(executionId);
          return;
        }

        // Continue polling despite errors
      }

      // Check if tracker was stopped (by timeout or manual stop)
      if (trackerState.stopped) {
        return;
      }

      // Increment poll attempts
      trackerState.pollAttempts++;

      // Check if we've exceeded max poll attempts
      if (trackerState.pollAttempts >= this.MAX_POLL_ATTEMPTS) {
        this.logger.warn(
          `Bridge tracking for ${executionId} stopped: exceeded max poll attempts (${this.MAX_POLL_ATTEMPTS})`,
        );
        const currentSnapshot =
          await this.stateService.getExecutionSnapshot(executionId);
        const currentBridge: any = currentSnapshot?.bridge || {};
        this.stateService.updateExecutionSnapshot(executionId, {
          bridge: {
            ...currentBridge,
            lastError: `Tracking stopped: exceeded max poll attempts (${this.MAX_POLL_ATTEMPTS})`,
            lastCheckedAt: new Date().toISOString(),
          },
        } as any);
        this.cleanupTracker(executionId);
        return;
      }

      // Schedule next poll with capped backoff

      // Backoff: 30s → 1m → 2m → 5m, then fixed 5m
      const nextDelay = Math.min(
        300000,
        30000 * Math.pow(2, Math.max(0, attempt - 1)),
      );
      const pollHandle = setTimeout(async () => {
        try {
          await poll(attempt + 1);
        } catch (err) {
          this.logger.error(
            `Unhandled error in poll scheduler for ${executionId}:`,
            err,
          );
          this.cleanupTracker(executionId);
        }
      }, nextDelay);
      trackerState.pollHandle = pollHandle;
    };

    // Kick off with initial 30s delay
    const initialPollHandle = setTimeout(async () => {
      try {
        await poll(1);
      } catch (err) {
        this.logger.error(
          `Unhandled error in initial poll for ${executionId}:`,
          err,
        );
        this.cleanupTracker(executionId);
      }
    }, this.INITIAL_POLL_DELAY_MS);
    trackerState.pollHandle = initialPollHandle;
  }

  stopTracking(executionId: string): void {
    this.logger.debug(`Manually stopping tracking for ${executionId}`);
    this.cleanupTracker(executionId);
  }

  /**
   * Handle timeout event - update execution state and cleanup tracker
   * @private
   */
  private async handleTimeout(
    executionId: string,
    timeoutMs: number,
  ): Promise<void> {
    this.logger.warn(
      `Bridge tracking timed out for ${executionId} after ${timeoutMs / 1000}s`,
    );

    try {
      // Update execution state with timeout information
      const currentSnapshot =
        await this.stateService.getExecutionSnapshot(executionId);
      const currentBridge: any = currentSnapshot?.bridge || {};

      await this.stateService.updateExecutionSnapshot(executionId, {
        bridge: {
          ...currentBridge,
          timedOut: true,
          timeoutDuration: timeoutMs,
          lastCheckedAt: Date.now(),
        },
        overall: 'TIMEOUT',
      } as any);

      await this.stateService.addStatusHistory(
        executionId,
        'timeout',
        `Bridge tracking timed out after ${timeoutMs / 1000}s`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update state for timed out execution ${executionId}: ${error.message}`,
      );
    }

    // Cleanup tracker resources
    this.cleanupTracker(executionId);
  }

  /**
   * Clean up tracker resources (timers and state)
   * @private
   */
  private cleanupTracker(executionId: string): void {
    const tracker = this.activeTrackers.get(executionId);
    if (!tracker) return;

    // Mark as stopped to prevent further polling
    tracker.stopped = true;

    // Clear timeout timer if exists
    if (tracker.timeoutHandle) {
      clearTimeout(tracker.timeoutHandle);
      tracker.timeoutHandle = undefined;
    }

    // Clear poll timer if exists
    if (tracker.pollHandle) {
      clearTimeout(tracker.pollHandle);
      tracker.pollHandle = undefined;
    }

    // Remove from active trackers
    this.activeTrackers.delete(executionId);

    this.logger.debug(`Cleaned up tracker for ${executionId}`);
  }

  /**
   * Manually refresh status for an execution (force immediate check)
   */
  async refreshStatus(executionId: string): Promise<boolean> {
    const snapshot = await this.stateService.getExecutionSnapshot(executionId);
    if (!snapshot || !snapshot.source.txHash) {
      return false;
    }

    // Use stored providerRef which contains full route metadata
    const providerRef =
      snapshot.providerRef ||
      (snapshot.routeId ? { routeId: snapshot.routeId } : {});

    const aggregator = (providerRef.aggregator || '').toString().toLowerCase();

    try {
      let status: any;

      // Call appropriate provider's status API
      if (aggregator === 'rubic') {
        status = await this.rubicService.getBridgeStatus(
          snapshot.source.txHash,
          providerRef,
        );
      } else if (aggregator === 'symbiosis') {
        const sourceChainId = 
          providerRef.fromChainId || 
          snapshot.source?.chainId ||
          undefined;

        const symbiosisStatus: any = await this.symbiosisService.status(
          snapshot.source.txHash,
          sourceChainId,
        );

        // Convert Symbiosis response to Rubic-compatible format
        // Symbiosis returns {status, txHash, message, timestamp, steps}
        status = {
          status: symbiosisStatus.status,
          destTxHash: symbiosisStatus.txHash,
          statusUrl: undefined,
          etaMs: undefined,
          destChainId: providerRef.toChainId,
        };
      } else {
        this.logger.warn(
          `Manual refresh not supported for aggregator=${aggregator}`,
        );
        return false;
      }

      const currentBridge: any = snapshot.bridge || {};
      let progressPercentage = 0;
      if (status.status === 'completed') {
        progressPercentage = 100;
      } else if (status.status === 'in_progress') {
        const startedAt = currentBridge.startedAt || Date.now();
        const etaMs = status.etaMs || currentBridge.etaMs || 30 * 60 * 1000;
        const elapsed = Date.now() - startedAt;
        progressPercentage = Math.min(95, Math.round((elapsed / etaMs) * 100));
      } else if (status.status === 'pending') {
        progressPercentage = 10;
      }

      this.stateService.updateExecutionSnapshot(executionId, {
        bridge: {
          ...currentBridge,
          status: status.status as BridgeStatus,
          statusUrl: status.statusUrl,
          etaMs: status.etaMs,
          destChainId: status.destChainId,
          destTxHash: status.destTxHash,
          toAmount: (status as any).toAmount,
          toAmountWei: (status as any).toAmountWei,
          lastCheckedAt: Date.now(),
          checkCount: (currentBridge.checkCount || 0) + 1,
          progressPercentage,
        },
        overall:
          status.status === 'completed'
            ? 'SUCCESS'
            : status.status === 'failed'
              ? 'FAILED'
              : 'IN_PROGRESS',
      } as any);

      this.stateService.addStatusHistory(
        executionId,
        status.status,
        `Manual refresh: ${status.destTxHash || 'pending'}`,
      );

      this.logger.log(
        `Manual status refresh for ${executionId}: ${status.status}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Manual status refresh failed for ${executionId} (${aggregator}): ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Get active tracker count (for monitoring)
   */
  getActiveTrackerCount(): number {
    return this.activeTrackers.size;
  }

  /**
   * Get tracker information for debugging
   */
  getTrackerInfo(executionId: string): {
    exists: boolean;
    stopped?: boolean;
    runningTime?: number;
    hasTimeout?: boolean;
    hasPoll?: boolean;
  } {
    const tracker = this.activeTrackers.get(executionId);
    if (!tracker) {
      return { exists: false };
    }

    return {
      exists: true,
      stopped: tracker.stopped,
      runningTime: Date.now() - tracker.startTime,
      hasTimeout: !!tracker.timeoutHandle,
      hasPoll: !!tracker.pollHandle,
    };
  }

  /**
   * Stop all active trackers (used for module cleanup)
   */
  stopAllTrackers(): void {
    this.logger.log(
      `Stopping all ${this.activeTrackers.size} active trackers`,
    );
    const executionIds = Array.from(this.activeTrackers.keys());
    executionIds.forEach((id) => this.cleanupTracker(id));
  }
}
