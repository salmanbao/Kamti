import { Injectable, Inject } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { SwapType, TokenInfo } from '@swap/dto/universal-swap-request.dto';
import { ExecutionResult } from '../execution/ports/swap-executor.interface';
import type { ExecutionStorage } from './execution-storage.interface';
import { ExecutionSnapshot } from './execution-storage.interface';

/**
 * Execution State Service
 * Manages execution state tracking and status queries
 *
 * Responsibilities:
 * - Execution tracking with pluggable storage backend
 * - Status updates
 * - State persistence
 *
 * Storage Backend:
 * - Uses ExecutionStorage interface for storage abstraction
 * - Default: InMemoryExecutionStorage (fast, not persistent)
 * - Alternative: MongoDBExecutionStorage (persistent, multi-instance)
 * - Configure in swap.module.ts
 */
@Injectable()
export class ExecutionStateService {
  constructor(
    @Inject('ExecutionStorage') private readonly storage: ExecutionStorage,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(ExecutionStateService.name);
  }

  /**
   * Save execution snapshot
   */
  async saveExecutionSnapshot(
    executionId: string,
    route: any,
    executionResult: ExecutionResult,
  ): Promise<void> {
    try {
      const swapType = this.determineSwapTypeFromRoute(route);
      const isCrossChain = swapType === SwapType.CROSS_CHAIN;

      const now = Date.now();
      const existing = await this.storage.get(executionId);

      // Build core snapshot fields
      const base: ExecutionSnapshot = {
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        routeId: route.routeId,
        providerRef: route.providerRef, // Store full providerRef for status tracking
        swapType,
        source: {
          chainId: executionResult.chainId,
          txHash: executionResult.transactionHash,
          explorerUrl: executionResult.explorerUrl,
        },
        overall: executionResult.success ? 'SUCCESS' : 'FAILED',
      } as ExecutionSnapshot;

      // Merge bridge details for cross-chain; preserve any balance-confirmed fields
      let bridge = existing?.bridge;
      if (isCrossChain) {
        bridge = {
          ...(existing?.bridge || {}),
          status:
            (executionResult.bridgeStatus as any) ||
            bridge?.status ||
            'initiated',
          statusUrl: executionResult.bridgeStatusUrl || bridge?.statusUrl,
          etaMs:
            (executionResult as any).estimatedCompletionTime ||
            bridge?.etaMs ||
            30 * 60 * 1000,
          startedAt: bridge?.startedAt || now,
          destChainId: executionResult.destChainId ?? bridge?.destChainId,
          destTxHash: executionResult.destTransactionHash ?? bridge?.destTxHash,
          destExplorerUrl:
            executionResult.destExplorerUrl ?? bridge?.destExplorerUrl,
          lastCheckedAt: bridge?.lastCheckedAt,
          checkCount: bridge?.checkCount,
          errorCount: bridge?.errorCount,
          lastError: bridge?.lastError,
          progressPercentage: bridge?.progressPercentage,
          balanceConfirmedAt: bridge?.balanceConfirmedAt,
          balanceDeltaRaw: bridge?.balanceDeltaRaw,
          expectedMinOutRaw: bridge?.expectedMinOutRaw,
          expectedEstOutRaw: bridge?.expectedEstOutRaw,
          confirmationSource: bridge?.confirmationSource,
        };
        base.overall =
          base.overall === 'SUCCESS' ? 'IN_PROGRESS' : base.overall;
      }

      // Final snapshot merges existing (to preserve roundTrip and history)
      const snapshot: ExecutionSnapshot = {
        ...(existing || {}),
        ...base,
        bridge,
        statusHistory: existing?.statusHistory,
        roundTrip: existing?.roundTrip,
      };

      await this.storage.set(executionId, snapshot);
      this.logger.debug(`Saved execution snapshot for ${executionId}`);
    } catch (e) {
      this.logger.warn(`Failed to save execution snapshot: ${e.message}`);
    }
  }

  /**
   * Get execution snapshot
   */
  async getExecutionSnapshot(
    executionId: string,
  ): Promise<ExecutionSnapshot | undefined> {
    return await this.storage.get(executionId);
  }

  /**
   * Update execution snapshot
   */
  async updateExecutionSnapshot(
    executionId: string,
    updates: Partial<ExecutionSnapshot>,
  ): Promise<void> {
    const success = await this.storage.update(executionId, updates);
    if (success) {
      this.logger.debug(`Updated execution snapshot for ${executionId}`);
    }
  }

  /**
   * Mark destination balance confirmed for cross-chain swap (no destTxHash yet).
   * Promotes overall status to SUCCESS and records balance delta & expectations.
   */
  async markDestinationBalanceConfirmed(
    executionId: string,
    params: {
      deltaRaw: string;
      expectedMinOutRaw?: string;
      expectedEstOutRaw?: string;
    },
  ): Promise<void> {
    const snapshot = await this.storage.get(executionId);
    if (!snapshot || !snapshot.bridge) {
      return;
    }
    // Avoid double-marking
    if (snapshot.bridge.balanceConfirmedAt) return;
    const now = Date.now();
    snapshot.bridge.balanceConfirmedAt = now;
    snapshot.bridge.balanceDeltaRaw = params.deltaRaw;
    snapshot.bridge.expectedMinOutRaw = params.expectedMinOutRaw;
    snapshot.bridge.expectedEstOutRaw = params.expectedEstOutRaw;
    snapshot.bridge.confirmationSource = 'balance';
    snapshot.bridge.status = 'completed';
    snapshot.overall = 'SUCCESS';
    snapshot.updatedAt = now;
    await this.addStatusHistory(
      executionId,
      'DESTINATION_BALANCE_CONFIRMED',
      `delta=${params.deltaRaw}`,
    );
    await this.storage.set(executionId, snapshot);
    this.logger.log(`Balance-confirmed completion recorded for ${executionId}`);
  }

  /**
   * Initialize round-trip context for auto-chaining
   */
  async setRoundTripContext(
    executionId: string,
    context: {
      intermediateToken: TokenInfo;
      finalOutputToken: TokenInfo;
      taker: string;
      recipient: string;
      slippageToleranceBps?: number;
      privateKey?: string;
      solanaPrivateKey?: string;
      bitcoinPrivateKey?: string;
    },
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.storage.get(executionId);
    const roundTrip = {
      enabled: true,
      intermediateToken: context.intermediateToken,
      finalOutputToken: context.finalOutputToken,
      taker: context.taker,
      recipient: context.recipient,
      slippageToleranceBps: context.slippageToleranceBps,
      privateKey: context.privateKey,
      solanaPrivateKey: context.solanaPrivateKey,
      bitcoinPrivateKey: context.bitcoinPrivateKey,
      leg1: { status: 'IN_PROGRESS' as const },
      leg2: { status: 'WAITING' as const },
    };

    const snapshot: ExecutionSnapshot = existing
      ? { ...existing, roundTrip, updatedAt: now }
      : ({
          createdAt: now,
          updatedAt: now,
          swapType: SwapType.ON_CHAIN,
          source: { chainId: 0 },
          overall: 'PENDING',
          roundTrip,
        } as ExecutionSnapshot);

    await this.storage.set(executionId, snapshot);
    await this.addStatusHistory(
      executionId,
      'ROUND_TRIP_INIT',
      'Round-trip context initialized',
    );
  }

  async markRoundTripLeg1Complete(
    executionId: string,
    txHash: string,
    actualReceivedRaw?: string,
  ): Promise<void> {
    const snap = await this.storage.get(executionId);
    if (!snap) return;
    const rt: NonNullable<ExecutionSnapshot['roundTrip']> =
      (snap.roundTrip as any) || ({} as any);
    rt.enabled = true;
    rt.leg1 = {
      status: 'SUCCESS',
      txHash,
      actualReceivedRaw: actualReceivedRaw || snap.bridge?.balanceDeltaRaw,
    };
    snap.roundTrip = rt;
    snap.updatedAt = Date.now();
    await this.addStatusHistory(
      executionId,
      'ROUND_TRIP_LEG1_SUCCESS',
      `tx=${txHash}`,
    );
    await this.storage.set(executionId, snap);
  }

  async markRoundTripLeg2Started(executionId: string): Promise<void> {
    const snap = await this.storage.get(executionId);
    if (!snap) return;
    const rt: NonNullable<ExecutionSnapshot['roundTrip']> =
      (snap.roundTrip as any) || ({} as any);
    rt.enabled = true;
    const leg2s: any = rt.leg2 || ({} as any);
    leg2s.status = 'STARTED';
    leg2s.startedAt = Date.now();
    rt.leg2 = leg2s;
    rt.autoChainTriggeredAt = rt.autoChainTriggeredAt || Date.now();
    snap.roundTrip = rt;
    snap.updatedAt = Date.now();
    await this.addStatusHistory(executionId, 'ROUND_TRIP_LEG2_STARTED');
    await this.storage.set(executionId, snap);
  }

  async markRoundTripLeg2Complete(
    executionId: string,
    txHash: string,
  ): Promise<void> {
    const snap = await this.storage.get(executionId);
    if (!snap) return;
    const rt: NonNullable<ExecutionSnapshot['roundTrip']> =
      (snap.roundTrip as any) || ({} as any);
    rt.enabled = true;
    const leg2c: any = rt.leg2 || ({} as any);
    leg2c.status = 'SUCCESS';
    leg2c.txHash = txHash;
    leg2c.completedAt = Date.now();
    rt.leg2 = leg2c;
    snap.roundTrip = rt;
    snap.updatedAt = Date.now();
    await this.addStatusHistory(
      executionId,
      'ROUND_TRIP_LEG2_SUCCESS',
      `tx=${txHash}`,
    );
    await this.storage.set(executionId, snap);
  }

  async markRoundTripLeg2Failed(
    executionId: string,
    error: string,
  ): Promise<void> {
    const snap = await this.storage.get(executionId);
    if (!snap) return;
    const rt: NonNullable<ExecutionSnapshot['roundTrip']> =
      (snap.roundTrip as any) || ({} as any);
    rt.enabled = true;
    const leg2f: any = rt.leg2 || ({} as any);
    leg2f.status = 'FAILED';
    leg2f.error = error;
    leg2f.completedAt = Date.now();
    rt.leg2 = leg2f;
    snap.roundTrip = rt;
    snap.updatedAt = Date.now();
    await this.addStatusHistory(executionId, 'ROUND_TRIP_LEG2_FAILED', error);
    await this.storage.set(executionId, snap);
  }

  /**
   * Add status history entry
   */
  async addStatusHistory(
    executionId: string,
    status: string,
    details?: string,
  ): Promise<void> {
    const snapshot = await this.storage.get(executionId);
    if (snapshot) {
      const history = snapshot.statusHistory || [];
      history.push({
        timestamp: Date.now(),
        status,
        details,
      });
      // Keep only last 20 entries
      if (history.length > 20) history.shift();
      snapshot.statusHistory = history;
      snapshot.updatedAt = Date.now();
      await this.storage.set(executionId, snapshot);
    }
  }

  /**
   * Get all execution IDs (for cleanup/monitoring)
   */
  async getAllExecutionIds(): Promise<string[]> {
    return await this.storage.getAllIds();
  }

  /**
   * Delete old execution snapshots (for memory management)
   */
  async cleanupOldSnapshots(
    maxAgeMs: number = 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const deleted = await this.storage.cleanup(maxAgeMs);
    if (deleted > 0) {
      this.logger.log(`Cleaned up ${deleted} old execution snapshots`);
    }
    return deleted;
  }

  /**
   * Determine swap type from route
   */
  private determineSwapTypeFromRoute(route: any): SwapType {
    if (!route.steps || route.steps.length === 0) {
      return SwapType.ON_CHAIN;
    }

    const firstStep = route.steps[0];
    const lastStep = route.steps[route.steps.length - 1];

    if (firstStep.chainId !== lastStep.chainId) {
      return SwapType.CROSS_CHAIN;
    }

    return SwapType.ON_CHAIN;
  }
}
