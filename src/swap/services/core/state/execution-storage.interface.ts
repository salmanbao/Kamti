import { SwapType, TokenInfo } from '@swap/dto/universal-swap-request.dto';

/**
 * Execution snapshot structure
 *
 * Represents a complete snapshot of swap execution state including:
 * - Source chain transaction details
 * - Bridge/cross-chain status
 * - Round-trip swap context and leg tracking
 * - Status history
 */
export interface ExecutionSnapshot {
  createdAt: number;
  updatedAt: number;
  routeId?: string;
  providerRef?: any; // Store full route.providerRef for status tracking (contains Rubic ID, transaction details, etc.)
  swapType: SwapType;
  source: {
    chainId: number | string;
    txHash?: string;
    explorerUrl?: string;
  };
  bridge?: {
    status:
      | 'initiated'
      | 'pending'
      | 'in_progress'
      | 'completed'
      | 'failed'
      | 'reverted';
    statusUrl?: string;
    etaMs?: number;
    startedAt?: number;
    destChainId?: number | string;
    destTxHash?: string;
    destExplorerUrl?: string;
    lastCheckedAt?: number;
    checkCount?: number;
    errorCount?: number;
    lastError?: string;
    progressPercentage?: number;
    // Balance-based confirmation fields
    balanceConfirmedAt?: number;
    balanceDeltaRaw?: string;
    expectedMinOutRaw?: string;
    expectedEstOutRaw?: string;
    confirmationSource?: 'balance' | 'bridge';
  };
  // Round-trip metadata (auto-chaining support)
  roundTrip?: {
    enabled: boolean;
    intermediateToken: TokenInfo; // request.buyToken of leg 1
    finalOutputToken: TokenInfo; // request.finalOutputToken
    taker: string;
    recipient: string;
    slippageToleranceBps?: number;
    // key material for signing leg 2 on the appropriate ecosystem
    privateKey?: string;
    solanaPrivateKey?: string;
    bitcoinPrivateKey?: string;
    leg1?: {
      status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';
      txHash?: string;
      actualReceivedRaw?: string;
    };
    leg2?: {
      status: 'PENDING' | 'WAITING' | 'STARTED' | 'SUCCESS' | 'FAILED';
      txHash?: string;
      startedAt?: number;
      completedAt?: number;
      error?: string;
    };
    autoChainTriggeredAt?: number;
  };
  overall: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'REVERTED';
  statusHistory?: Array<{
    timestamp: number;
    status: string;
    details?: string;
  }>;
}

/**
 * ExecutionStorage Interface
 *
 * Standard interface for storing and retrieving execution snapshots.
 * Implementations can use in-memory storage, Redis, MongoDB, or any other backing store.
 *
 * Thread-safety: Each executionId is stored separately to prevent cross-execution races.
 * Implementations should ensure atomic read-modify-write operations within a single executionId.
 *
 * Implementations:
 * - InMemoryExecutionStorage: Fast in-memory storage with deep cloning
 * - MongoDBExecutionStorage: Persistent database storage with atomic updates
 */
export interface ExecutionStorage {
  /**
   * Retrieve execution snapshot by ID
   *
   * @param executionId Unique execution identifier
   * @returns Snapshot if found, undefined otherwise
   */
  get(executionId: string): Promise<ExecutionSnapshot | undefined>;

  /**
   * Store or replace execution snapshot
   *
   * @param executionId Unique execution identifier
   * @param snapshot Complete snapshot to store
   */
  set(executionId: string, snapshot: ExecutionSnapshot): Promise<void>;

  /**
   * Atomically update execution snapshot with partial data
   *
   * Performs read-modify-write as a single atomic operation to prevent race conditions.
   * If executionId doesn't exist, the update is silently ignored.
   *
   * @param executionId Unique execution identifier
   * @param updates Partial snapshot fields to merge
   * @returns true if updated, false if executionId not found
   */
  update(
    executionId: string,
    updates: Partial<ExecutionSnapshot>,
  ): Promise<boolean>;

  /**
   * Delete execution snapshot
   *
   * @param executionId Unique execution identifier
   * @returns true if deleted, false if not found
   */
  delete(executionId: string): Promise<boolean>;

  /**
   * Get all execution IDs
   *
   * @returns Array of all stored execution IDs
   */
  getAllIds(): Promise<string[]>;

  /**
   * Delete old execution snapshots based on age
   *
   * @param maxAgeMs Maximum age in milliseconds (default: 24 hours)
   * @returns Number of snapshots deleted
   */
  cleanup(maxAgeMs?: number): Promise<number>;

  /**
   * Check if storage backend is healthy and available
   *
   * @returns true if storage is operational
   */
  healthCheck(): Promise<boolean>;
}
