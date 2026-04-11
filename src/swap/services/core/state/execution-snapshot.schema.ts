import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

/**
 * Mongoose Document type for ExecutionSnapshot
 */
export type ExecutionSnapshotDocument = ExecutionSnapshotModel &
  Document & {
    createdAt: Date;
    updatedAt: Date;
  };

/**
 * ExecutionSnapshot MongoDB Schema
 *
 * Stores execution state snapshots for swap executions with automatic TTL cleanup.
 *
 * Indexes:
 * - executionId: Unique index for fast lookups
 * - createdAt: TTL index for automatic deletion after 7 days
 * - updatedAt: Secondary index for queries
 */
@Schema({
  timestamps: true,
  collection: 'execution_snapshots',
})
export class ExecutionSnapshotModel {
  /**
   * Unique execution identifier
   */
  @Prop({ required: true, unique: true, index: true })
  executionId: string;

  /**
   * Complete execution snapshot data
   * Stored as flexible JSON to accommodate varying execution types
   */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  snapshot: {
    // Source chain details
    source?: {
      chainId: number;
      chainName: string;
      tokenAddress: string;
      tokenSymbol: string;
      amount: string;
      txHash?: string;
      status?: string;
    };

    // Bridge transaction details (for cross-chain swaps)
    bridge?: {
      txHash?: string;
      status?: string;
      sourceChainId?: number;
      destinationChainId?: number;
      bridgeProvider?: string;
      expectedAmount?: string;
      receivedAmount?: string;
      transferId?: string;
    };

    // Round-trip swap context (for arbitrage/testing)
    roundTrip?: {
      leg1ExecutionId?: string;
      leg2ExecutionId?: string;
      leg1Status?: string;
      leg2Status?: string;
      leg1CompletedAt?: number;
      leg2StartedAt?: number;
      leg2CompletedAt?: number;
      initialAmount?: string;
      finalAmount?: string;
      profitLoss?: string;
      totalDuration?: number;
    };

    // Status history for tracking execution progress
    statusHistory?: Array<{
      status: string;
      timestamp: number;
      message?: string;
      details?: any;
    }>;

    // Additional metadata
    swapType?: string;
    protocol?: string;
    destinationChainId?: number;
    destinationTokenAddress?: string;
    createdAt?: number;
    updatedAt?: number;

    // Flexible field for any additional data
    [key: string]: any;
  };
}

export const ExecutionSnapshotSchema = SchemaFactory.createForClass(
  ExecutionSnapshotModel,
);

// Add TTL index: automatically delete documents after 7 days (604800 seconds)
ExecutionSnapshotSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 604800 }, // 7 days
);
