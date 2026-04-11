import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { Server, Socket } from 'socket.io';
import { ChainListenerService } from './chain-listener.service';
import {
  ConfirmationEvent,
  BalanceChangeEvent,
} from './chain-listener.interface';

/**
 * Transaction Monitor Gateway
 *
 * WebSocket server for real-time transaction monitoring across all blockchains.
 * Clients can subscribe to specific execution IDs or addresses for live updates.
 *
 * Requirements:
 * - #4: WebSocket mechanism for transaction monitoring (EVM, Solana, Bitcoin)
 * - #5: Emit events for confirmation milestones
 * - Real-time updates for round-trip swap progress
 *
 * Events Emitted:
 * - transaction:pending - TX submitted to mempool/network
 * - transaction:confirmed - First confirmation received
 * - transaction:finalized - Full finality reached
 * - transaction:failed - TX failed or reverted
 * - roundtrip:leg1_complete - First swap in round-trip completed
 * - roundtrip:leg2_started - Second swap initiated
 * - roundtrip:leg2_complete - Round-trip completed
 * - roundtrip:partial_failure - First swap succeeded, second failed
 * - bridge:source_confirmed - Cross-chain: source transaction confirmed
 * - bridge:destination_pending - Cross-chain: waiting for destination
 * - bridge:destination_confirmed - Cross-chain: destination transaction confirmed
 */
@WebSocketGateway({
  cors: {
    origin: process.env.WEBSOCKET_CORS_ORIGIN || '*',
    credentials: true,
  },
  namespace: '/transaction-monitor',
})
export class TransactionMonitorGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger: WinstonLoggerService;
  private activeSubscriptions: Map<string, Set<string>> = new Map(); // executionId -> Set of socket IDs

  constructor(
    private readonly winstonLogger: WinstonLoggerService,
    private readonly chainListener: ChainListenerService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(TransactionMonitorGateway.name);
  }

  afterInit(server: Server) {
    this.logger.log('Transaction Monitor WebSocket Gateway initialized');
    this.logger.log(`CORS origin: ${process.env.WEBSOCKET_CORS_ORIGIN || '*'}`);
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.server.to(client.id).emit('connection:established', {
      socketId: client.id,
      timestamp: new Date().toISOString(),
      message: 'Connected to transaction monitoring service',
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Cleanup subscriptions
    for (const [executionId, socketIds] of this.activeSubscriptions.entries()) {
      socketIds.delete(client.id);
      if (socketIds.size === 0) {
        this.activeSubscriptions.delete(executionId);
      }
    }
  }

  /**
   * Subscribe to execution ID for transaction updates
   *
   * Client usage:
   * socket.emit('subscribe', { executionId: 'exec_123' });
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @MessageBody() data: { executionId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { executionId } = data;

    if (!executionId) {
      client.emit('error', { message: 'executionId is required' });
      return;
    }

    // Join room for this execution ID
    client.join(executionId);

    // Track subscription
    if (!this.activeSubscriptions.has(executionId)) {
      this.activeSubscriptions.set(executionId, new Set());
    }
    this.activeSubscriptions.get(executionId)!.add(client.id);

    this.logger.log(
      `Client ${client.id} subscribed to execution ${executionId}`,
    );

    client.emit('subscribed', {
      executionId,
      timestamp: new Date().toISOString(),
      message: `Subscribed to execution ${executionId}`,
    });
  }

  /**
   * Unsubscribe from execution ID
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @MessageBody() data: { executionId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { executionId } = data;

    if (!executionId) {
      client.emit('error', { message: 'executionId is required' });
      return;
    }

    client.leave(executionId);

    const socketIds = this.activeSubscriptions.get(executionId);
    if (socketIds) {
      socketIds.delete(client.id);
      if (socketIds.size === 0) {
        this.activeSubscriptions.delete(executionId);
      }
    }

    this.logger.log(
      `Client ${client.id} unsubscribed from execution ${executionId}`,
    );

    client.emit('unsubscribed', {
      executionId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get active subscriptions count
   */
  @SubscribeMessage('get_stats')
  handleGetStats(@ConnectedSocket() client: Socket): void {
    client.emit('stats', {
      activeExecutions: this.activeSubscriptions.size,
      connectedClients: this.server.sockets.sockets.size,
      timestamp: new Date().toISOString(),
    });
  }

  // ==================== SERVER-SIDE EVENT EMISSION ====================
  // These methods are called by orchestration service to emit events

  /**
   * Emit transaction pending event
   */
  emitTransactionPending(
    executionId: string,
    data: {
      txHash: string;
      chainId: number | string;
      ecosystem: string;
      from: string;
      to?: string;
      value?: string;
    },
  ): void {
    this.server.to(executionId).emit('transaction:pending', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Emitted transaction:pending for ${executionId}: ${data.txHash}`,
    );
  }

  /**
   * Emit transaction confirmed event
   */
  emitTransactionConfirmed(
    executionId: string,
    event: ConfirmationEvent & {
      chainId: number | string;
      ecosystem: string;
    },
  ): void {
    this.server.to(executionId).emit('transaction:confirmed', {
      executionId,
      ...event,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Emitted transaction:confirmed for ${executionId}: ${event.txHash} (${event.confirmations} confirmations)`,
    );
  }

  /**
   * Emit transaction finalized event
   */
  emitTransactionFinalized(
    executionId: string,
    data: {
      txHash: string;
      chainId: number | string;
      ecosystem: string;
      confirmations: number;
      blockNumber: number;
      gasUsed?: string;
    },
  ): void {
    this.server.to(executionId).emit('transaction:finalized', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Emitted transaction:finalized for ${executionId}: ${data.txHash}`,
    );
  }

  /**
   * Emit transaction failed event
   */
  emitTransactionFailed(
    executionId: string,
    data: {
      txHash?: string;
      chainId: number | string;
      ecosystem: string;
      error: string;
      reason?: string;
    },
  ): void {
    this.server.to(executionId).emit('transaction:failed', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Emitted transaction:failed for ${executionId}: ${data.error}`,
    );
  }

  /**
   * Emit round-trip leg 1 complete event
   */
  emitRoundTripLeg1Complete(
    executionId: string,
    data: {
      txHash: string;
      chainId: number | string;
      ecosystem: string;
      inputToken: string;
      outputToken: string;
      inputAmount: string;
      outputAmount: string;
      actualReceivedAmount: string;
      confirmations: number;
    },
  ): void {
    this.server.to(executionId).emit('roundtrip:leg1_complete', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Emitted roundtrip:leg1_complete for ${executionId}`);
  }

  /**
   * Emit round-trip leg 2 started event
   */
  emitRoundTripLeg2Started(
    executionId: string,
    data: {
      txHash: string;
      chainId: number | string;
      ecosystem: string;
      inputToken: string;
      outputToken: string;
      inputAmount: string;
      estimatedOutput: string;
    },
  ): void {
    this.server.to(executionId).emit('roundtrip:leg2_started', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Emitted roundtrip:leg2_started for ${executionId}`);
  }

  /**
   * Emit round-trip leg 2 complete event
   */
  emitRoundTripLeg2Complete(
    executionId: string,
    data: {
      txHash: string;
      chainId: number | string;
      ecosystem: string;
      inputToken: string;
      outputToken: string;
      inputAmount: string;
      outputAmount: string;
      actualReceivedAmount: string;
      confirmations: number;
      profitability: {
        initialAmount: string;
        finalAmount: string;
        profitLoss: string;
        profitLossBps: number;
        isProfitable: boolean;
      };
    },
  ): void {
    this.server.to(executionId).emit('roundtrip:leg2_complete', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Emitted roundtrip:leg2_complete for ${executionId}`);
  }

  /**
   * Emit round-trip partial failure event (requirement #7)
   */
  emitRoundTripPartialFailure(
    executionId: string,
    data: {
      swap1: {
        txHash: string;
        status: 'SUCCESS';
        outputAmount: string;
        actualReceivedAmount: string;
      };
      swap2: {
        txHash?: string;
        status: 'FAILED';
        error: string;
        reason: string;
      };
      recoveryInstructions: string;
    },
  ): void {
    this.server.to(executionId).emit('roundtrip:partial_failure', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Emitted roundtrip:partial_failure for ${executionId}`);
  }

  /**
   * Emit bridge source confirmed event
   */
  emitBridgeSourceConfirmed(
    executionId: string,
    data: {
      txHash: string;
      sourceChainId: number | string;
      sourceEcosystem: string;
      destinationChainId: number | string;
      destinationEcosystem: string;
      bridgeProvider: string;
      estimatedWaitMinutes: number;
    },
  ): void {
    this.server.to(executionId).emit('bridge:source_confirmed', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Emitted bridge:source_confirmed for ${executionId}`);
  }

  /**
   * Emit bridge destination pending event
   */
  emitBridgeDestinationPending(
    executionId: string,
    data: {
      sourceChainId: number | string;
      destinationChainId: number | string;
      bridgeProvider: string;
      elapsedMinutes: number;
      estimatedRemainingMinutes: number;
    },
  ): void {
    this.server.to(executionId).emit('bridge:destination_pending', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Emitted bridge:destination_pending for ${executionId}`);
  }

  /**
   * Emit bridge destination confirmed event
   */
  emitBridgeDestinationConfirmed(
    executionId: string,
    data: {
      txHash: string;
      destinationChainId: number | string;
      destinationEcosystem: string;
      actualReceivedAmount: string;
      totalBridgeTimeMinutes: number;
    },
  ): void {
    this.server.to(executionId).emit('bridge:destination_confirmed', {
      executionId,
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Emitted bridge:destination_confirmed for ${executionId}`);
  }

  /**
   * Monitor transaction and emit events automatically
   *
   * This method is called by orchestration service after transaction submission
   * to automatically track and emit confirmation events.
   */
  async monitorTransaction(
    executionId: string,
    chainId: number | string,
    ecosystem: string,
    txHash: string,
    minConfirmations: number,
  ): Promise<void> {
    this.logger.log(
      `Starting automatic monitoring for ${executionId}: ${txHash} on ${ecosystem}:${chainId}`,
    );

    try {
      // Emit pending event
      this.emitTransactionPending(executionId, {
        txHash,
        chainId,
        ecosystem,
        from: '', // Would be populated from transaction data
      });

      // Wait for confirmations with callback
      await this.chainListener.waitForConfirmations(
        chainId,
        ecosystem,
        txHash,
        minConfirmations,
        (event) => {
          // Emit confirmation event
          this.emitTransactionConfirmed(executionId, {
            ...event,
            chainId,
            ecosystem,
          });

          // Emit finalized event if reached
          if (event.isFinalized) {
            this.emitTransactionFinalized(executionId, {
              txHash: event.txHash,
              chainId,
              ecosystem,
              confirmations: event.confirmations,
              blockNumber: event.blockNumber,
            });
          }
        },
      );
    } catch (error) {
      this.logger.error(
        `Transaction monitoring failed for ${executionId}: ${error.message}`,
      );

      this.emitTransactionFailed(executionId, {
        txHash,
        chainId,
        ecosystem,
        error: error.message,
      });
    }
  }
}
