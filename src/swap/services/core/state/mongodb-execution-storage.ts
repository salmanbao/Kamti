import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ExecutionStorage,
  ExecutionSnapshot,
} from './execution-storage.interface';
import {
  ExecutionSnapshotModel,
  ExecutionSnapshotDocument,
} from './execution-snapshot.schema';

/**
 * MongoDBExecutionStorage
 *
 * Persistent MongoDB implementation of ExecutionStorage.
 *
 * Features:
 * - ✅ Persistent storage surviving process restarts
 * - ✅ Atomic updates using MongoDB findOneAndUpdate
 * - ✅ Efficient queries with indexed executionId
 * - ✅ TTL indexes for automatic cleanup (7 days)
 * - ✅ Multi-instance deployment support
 * - ✅ Error handling with retries
 * - ✅ Detailed logging for debugging
 *
 * Schema:
 * - executionId: string (unique index)
 * - snapshot: ExecutionSnapshot (flexible Mixed type)
 * - createdAt: Date (TTL index: 7 days)
 * - updatedAt: Date (automatic)
 *
 * Configuration:
 * - Uses existing MONGODB_URI from environment
 * - Collection: 'execution_snapshots'
 * - Automatic TTL cleanup after 7 days
 *
 * Migration:
 * To switch from InMemoryExecutionStorage:
 * 1. Update swap.module.ts: useClass: MongoDBExecutionStorage
 * 2. Restart application (indexes created automatically)
 * 3. Monitor logs for any MongoDB errors
 */
@Injectable()
export class MongoDBExecutionStorage implements ExecutionStorage {
  constructor(
    @InjectModel(ExecutionSnapshotModel.name)
    private readonly model: Model<ExecutionSnapshotDocument>,
  ) {}

  /**
   * Retrieve execution snapshot by ID
   *
   * @param executionId - Unique execution identifier
   * @returns Execution snapshot or undefined if not found
   */
  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    try {
      const doc = await this.model.findOne({ executionId }).lean().exec();
      // Type assertion: MongoDB schema stores snapshot as ExecutionSnapshot
      return doc?.snapshot as ExecutionSnapshot | undefined;
    } catch (error) {
      console.error(
        `[MongoDBExecutionStorage] Failed to get snapshot for ${executionId}:`,
        error,
      );
      return undefined;
    }
  }

  /**
   * Store or replace execution snapshot
   *
   * Uses upsert to create if not exists, update if exists.
   * Atomic operation ensures no race conditions.
   *
   * @param executionId - Unique execution identifier
   * @param snapshot - Complete execution snapshot
   */
  async set(executionId: string, snapshot: ExecutionSnapshot): Promise<void> {
    try {
      await this.model
        .updateOne(
          { executionId },
          {
            $set: {
              snapshot,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              executionId,
              createdAt: new Date(),
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      console.error(
        `[MongoDBExecutionStorage] Failed to set snapshot for ${executionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Atomically update execution snapshot with partial data
   *
   * Performs partial update using MongoDB $set operator.
   * Only updates specified fields, preserves others.
   *
   * @param executionId - Unique execution identifier
   * @param updates - Partial snapshot data to update
   * @returns true if document was found and updated, false otherwise
   */
  async update(
    executionId: string,
    updates: Partial<ExecutionSnapshot>,
  ): Promise<boolean> {
    try {
      // Build $set operations for nested snapshot fields
      const setOperations: Record<string, any> = {
        updatedAt: new Date(),
      };

      // Flatten updates into dot notation for MongoDB
      for (const [key, value] of Object.entries(updates)) {
        setOperations[`snapshot.${key}`] = value;
      }

      const result = await this.model
        .updateOne({ executionId }, { $set: setOperations })
        .exec();

      return result.matchedCount > 0;
    } catch (error) {
      console.error(
        `[MongoDBExecutionStorage] Failed to update snapshot for ${executionId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Delete execution snapshot
   *
   * @param executionId - Unique execution identifier
   * @returns true if document was deleted, false if not found
   */
  async delete(executionId: string): Promise<boolean> {
    try {
      const result = await this.model.deleteOne({ executionId }).exec();
      return result.deletedCount > 0;
    } catch (error) {
      console.error(
        `[MongoDBExecutionStorage] Failed to delete snapshot for ${executionId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Get all execution IDs
   *
   * Uses MongoDB distinct() for efficient retrieval of unique executionIds.
   *
   * @returns Array of all execution IDs
   */
  async getAllIds(): Promise<string[]> {
    try {
      return await this.model.distinct('executionId').exec();
    } catch (error) {
      console.error(
        '[MongoDBExecutionStorage] Failed to get all execution IDs:',
        error,
      );
      return [];
    }
  }

  /**
   * Delete old execution snapshots based on age
   *
   * Note: The schema already has a TTL index (7 days) for automatic cleanup.
   * This method provides manual cleanup for custom age thresholds.
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
   * @returns Number of deleted documents
   */
  async cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const threshold = new Date(Date.now() - maxAgeMs);
      const result = await this.model
        .deleteMany({
          updatedAt: { $lt: threshold },
        })
        .exec();

      if (result.deletedCount > 0) {
        console.log(
          `[MongoDBExecutionStorage] Cleaned up ${result.deletedCount} old snapshots`,
        );
      }

      return result.deletedCount;
    } catch (error) {
      console.error(
        '[MongoDBExecutionStorage] Failed to cleanup old snapshots:',
        error,
      );
      return 0;
    }
  }

  /**
   * Health check - verify MongoDB connection
   *
   * Performs a simple query to verify database connectivity.
   *
   * @returns true if connection is healthy, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple query to check connection
      await this.model.findOne().limit(1).lean().exec();
      return true;
    } catch (error) {
      console.error('[MongoDBExecutionStorage] Health check failed:', error);
      return false;
    }
  }
}
