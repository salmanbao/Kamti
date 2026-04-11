import { Injectable } from '@nestjs/common';
import {
  ExecutionStorage,
  ExecutionSnapshot,
} from './execution-storage.interface';

/**
 * InMemoryExecutionStorage
 *
 * Thread-safe in-memory implementation of ExecutionStorage.
 *
 * Features:
 * - Deep cloning on get/set to prevent reference-based mutations
 * - Atomic update operations to prevent read-modify-write races
 * - Automatic cleanup of old snapshots
 * - Fast access with O(1) lookups
 *
 * Thread-safety approach:
 * - Each executionId gets its own isolated snapshot (deep cloned)
 * - Update operations are atomic within a single executionId
 * - No cross-execution race conditions possible
 *
 * Limitations:
 * - Data lost on process restart (not persistent)
 * - Memory usage grows with number of executions (use cleanup)
 * - Not suitable for multi-instance deployments (use MongoDB instead)
 */
@Injectable()
export class InMemoryExecutionStorage implements ExecutionStorage {
  private readonly store = new Map<string, ExecutionSnapshot>();

  /**
   * Retrieve execution snapshot by ID
   * Returns deep clone to prevent external mutations
   */
  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    const snapshot = this.store.get(executionId);
    if (!snapshot) {
      return undefined;
    }
    // Deep clone to prevent reference-based mutations
    return this.deepClone(snapshot);
  }

  /**
   * Store or replace execution snapshot
   * Deep clones input to prevent external mutations affecting stored data
   */
  async set(executionId: string, snapshot: ExecutionSnapshot): Promise<void> {
    // Deep clone to prevent external mutations
    this.store.set(executionId, this.deepClone(snapshot));
  }

  /**
   * Atomically update execution snapshot with partial data
   *
   * Performs read-modify-write as a single atomic operation.
   * Returns false if executionId doesn't exist.
   */
  async update(
    executionId: string,
    updates: Partial<ExecutionSnapshot>,
  ): Promise<boolean> {
    const snapshot = this.store.get(executionId);
    if (!snapshot) {
      return false;
    }

    // Atomic read-modify-write
    // Since we're in-memory and Node.js is single-threaded,
    // this operation is naturally atomic
    const updated = {
      ...snapshot,
      ...updates,
      updatedAt: Date.now(),
    };

    this.store.set(executionId, updated);
    return true;
  }

  /**
   * Delete execution snapshot
   */
  async delete(executionId: string): Promise<boolean> {
    return this.store.delete(executionId);
  }

  /**
   * Get all execution IDs
   */
  async getAllIds(): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  /**
   * Delete old execution snapshots based on age
   *
   * @param maxAgeMs Maximum age in milliseconds (default: 24 hours)
   * @returns Number of snapshots deleted
   */
  async cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    const threshold = now - maxAgeMs;
    let deletedCount = 0;

    for (const [executionId, snapshot] of this.store.entries()) {
      if (snapshot.updatedAt < threshold) {
        this.store.delete(executionId);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Health check - always healthy for in-memory storage
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Deep clone utility
   *
   * Creates a deep copy of an object to prevent reference-based mutations.
   * Uses JSON serialization which works for plain data objects.
   *
   * Note: Does not preserve functions, symbols, or circular references.
   * This is acceptable for ExecutionSnapshot which contains only data.
   */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }
}
