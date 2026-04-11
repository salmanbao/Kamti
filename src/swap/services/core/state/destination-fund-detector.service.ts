import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { ExecutionStateService } from './execution-state.service';

/**
 * Retry configuration for balance checks
 */
interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Balance probe result
 */
interface BalanceProbeResult {
  success: boolean;
  currentBalance: string;
  delta: string;
  meetsExpectation: boolean;
  confidence: 'high' | 'medium' | 'low';
  error?: string;
  attempt?: number;
}

/**
 * WebSocket subscription config
 */
interface WebSocketConfig {
  enabled: boolean;
  provider: 'alchemy' | 'quicknode' | 'helius' | 'chainstack';
  endpoint?: string;
  apiKey?: string;
}

/**
 * Destination Fund Detector Service
 *
 * Multi-layered approach to detect fund transfers on destination chain:
 * 1. Rubic status endpoint (primary, but slow/unreliable)
 * 2. Balance delta detection with exponential backoff retries
 * 3. WebSocket real-time transfer detection (future)
 *
 * Features:
 * - Resilient balance probing with 3 retries and exponential backoff
 * - Amount range matching (min/estimated output tolerance)
 * - Confidence scoring based on delta accuracy
 * - Fallback to multiple detection methods
 * - RPC endpoint failover
 */
@Injectable()
export class DestinationFundDetectorService {
  private readonly defaultRetryConfig: RetryConfig = {
    maxAttempts: 3,
    baseDelayMs: 2000, // 2s
    maxDelayMs: 10000, // 10s
    backoffMultiplier: 2.5,
  };

  // Active WebSocket subscriptions: executionId -> subscription handle
  private readonly wsSubscriptions = new Map<string, any>();

  constructor(
    private readonly walletService: WalletService,
    private readonly stateService: ExecutionStateService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(DestinationFundDetectorService.name);
  }

  /**
   * Probe destination balance with retry logic
   *
   * @param executionId - Execution ID
   * @param destChainId - Destination chain ID
   * @param recipient - Recipient address
   * @param tokenAddress - Token address (undefined for native)
   * @param ecosystem - Blockchain ecosystem
   * @param preBalanceRaw - Pre-transfer balance
   * @param expectedMinOutRaw - Minimum expected output
   * @param expectedEstOutRaw - Estimated expected output
   * @param retryConfig - Optional retry configuration
   * @returns Balance probe result
   */
  async probeBalanceWithRetry(
    executionId: string,
    destChainId: number | string,
    recipient: string,
    tokenAddress: string | undefined,
    ecosystem: 'evm' | 'solana' | 'bitcoin' | 'tron',
    preBalanceRaw: string,
    expectedMinOutRaw?: string,
    expectedEstOutRaw?: string,
    retryConfig?: RetryConfig,
  ): Promise<BalanceProbeResult> {
    const config = retryConfig || this.defaultRetryConfig;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        this.logger.debug(
          `[${executionId}] Balance probe attempt ${attempt}/${config.maxAttempts}`,
          {
            destChainId,
            recipient,
            tokenAddress,
            ecosystem,
          },
        );

        // Fetch current balance
        const balanceInfo = await this.walletService.getBalance(
          destChainId,
          recipient,
          tokenAddress,
          ecosystem,
        );

        const currentBalance = balanceInfo.balance;
        const pre = BigInt(preBalanceRaw);
        const cur = BigInt(currentBalance);
        const delta = cur - pre;

        this.logger.log(
          `[${executionId}] Balance probe successful (attempt ${attempt})`,
          {
            preBalance: preBalanceRaw,
            currentBalance,
            delta: delta.toString(),
          },
        );

        // Check if delta meets expectation
        const { meetsExpectation, confidence } = this.evaluateBalanceDelta(
          delta,
          expectedMinOutRaw,
          expectedEstOutRaw,
        );

        return {
          success: true,
          currentBalance,
          delta: delta.toString(),
          meetsExpectation,
          confidence,
          attempt,
        };
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `[${executionId}] Balance probe failed (attempt ${attempt}/${config.maxAttempts})`,
          {
            error: error.message,
            destChainId,
            ecosystem,
          },
        );

        // Don't sleep after last attempt
        if (attempt < config.maxAttempts) {
          const delay = Math.min(
            config.baseDelayMs *
              Math.pow(config.backoffMultiplier, attempt - 1),
            config.maxDelayMs,
          );
          this.logger.debug(
            `[${executionId}] Retrying balance probe in ${delay}ms...`,
          );
          await this.sleep(delay);
        }
      }
    }

    // All attempts failed
    return {
      success: false,
      currentBalance: '0',
      delta: '0',
      meetsExpectation: false,
      confidence: 'low',
      error: lastError?.message || 'Balance probe failed after all retries',
    };
  }

  /**
   * Evaluate if balance delta meets expectations
   *
   * @param delta - Actual balance delta
   * @param expectedMinOutRaw - Minimum expected output
   * @param expectedEstOutRaw - Estimated expected output
   * @returns Evaluation result with confidence score
   */
  private evaluateBalanceDelta(
    delta: bigint,
    expectedMinOutRaw?: string,
    expectedEstOutRaw?: string,
  ): { meetsExpectation: boolean; confidence: 'high' | 'medium' | 'low' } {
    // No change detected
    if (delta <= 0n) {
      return { meetsExpectation: false, confidence: 'low' };
    }

    // Compare against minimum expected output (strict)
    if (expectedMinOutRaw) {
      const minExpected = BigInt(expectedMinOutRaw);
      if (delta >= minExpected) {
        // Delta exceeds minimum → high confidence match
        const ratio = Number((delta * 10000n) / minExpected) / 10000;
        return {
          meetsExpectation: true,
          confidence: ratio >= 0.95 && ratio <= 1.1 ? 'high' : 'medium',
        };
      }
    }

    // Compare against estimated output (with tolerance)
    if (expectedEstOutRaw) {
      const estExpected = BigInt(expectedEstOutRaw);
      // Accept delta within ±5% of estimated
      const lowerBound = (estExpected * 95n) / 100n;
      const upperBound = (estExpected * 105n) / 100n;

      if (delta >= lowerBound && delta <= upperBound) {
        const ratio = Number((delta * 10000n) / estExpected) / 10000;
        return {
          meetsExpectation: true,
          confidence: ratio >= 0.98 && ratio <= 1.02 ? 'high' : 'medium',
        };
      }

      // Delta present but outside range → low confidence
      if (delta > 0n) {
        return { meetsExpectation: false, confidence: 'low' };
      }
    }

    // Delta present but no expectations → medium confidence
    if (delta > 0n) {
      return { meetsExpectation: true, confidence: 'medium' };
    }

    return { meetsExpectation: false, confidence: 'low' };
  }

  /**
   * Subscribe to WebSocket for real-time transfer detection
   *
   * Future implementation: Monitor incoming transfers to recipient address
   * matching expected amount range.
   *
   * @param executionId - Execution ID
   * @param destChainId - Destination chain ID
   * @param recipient - Recipient address
   * @param tokenAddress - Token address
   * @param ecosystem - Blockchain ecosystem
   * @param expectedMinOutRaw - Minimum expected amount
   * @param expectedEstOutRaw - Estimated expected amount
   * @param wsConfig - WebSocket configuration
   */
  async subscribeToTransfers(
    executionId: string,
    destChainId: number | string,
    recipient: string,
    tokenAddress: string | undefined,
    ecosystem: 'evm' | 'solana' | 'bitcoin' | 'tron',
    expectedMinOutRaw?: string,
    expectedEstOutRaw?: string,
    wsConfig?: WebSocketConfig,
  ): Promise<void> {
    if (!wsConfig?.enabled) {
      this.logger.debug(
        `[${executionId}] WebSocket transfer detection disabled`,
      );
      return;
    }

    this.logger.log(
      `[${executionId}] Setting up WebSocket transfer subscription`,
      {
        destChainId,
        recipient,
        tokenAddress,
        ecosystem,
        provider: wsConfig.provider,
      },
    );

    try {
      // Implementation depends on provider
      switch (wsConfig.provider) {
        case 'alchemy':
          await this.subscribeAlchemy(
            executionId,
            destChainId,
            recipient,
            tokenAddress,
            expectedMinOutRaw,
            expectedEstOutRaw,
            wsConfig,
          );
          break;
        case 'quicknode':
          await this.subscribeQuicknode(
            executionId,
            destChainId,
            recipient,
            tokenAddress,
            expectedMinOutRaw,
            expectedEstOutRaw,
            wsConfig,
          );
          break;
        case 'helius':
          await this.subscribeHelius(
            executionId,
            destChainId,
            recipient,
            tokenAddress,
            expectedMinOutRaw,
            expectedEstOutRaw,
            wsConfig,
          );
          break;
        case 'chainstack':
          await this.subscribeChainstack(
            executionId,
            destChainId,
            recipient,
            tokenAddress,
            expectedMinOutRaw,
            expectedEstOutRaw,
            wsConfig,
          );
          break;
        default:
          this.logger.warn(
            `[${executionId}] Unsupported WebSocket provider: ${wsConfig.provider}`,
          );
      }
    } catch (error) {
      this.logger.error(
        `[${executionId}] Failed to subscribe to WebSocket transfers: ${error.message}`,
      );
    }
  }

  /**
   * Unsubscribe from WebSocket transfer monitoring
   *
   * @param executionId - Execution ID
   */
  async unsubscribeFromTransfers(executionId: string): Promise<void> {
    const subscription = this.wsSubscriptions.get(executionId);
    if (!subscription) {
      return;
    }

    try {
      // Close WebSocket connection
      if (subscription.ws && typeof subscription.ws.close === 'function') {
        subscription.ws.close();
      }
      this.wsSubscriptions.delete(executionId);
      this.logger.log(`[${executionId}] Unsubscribed from WebSocket transfers`);
    } catch (error) {
      this.logger.error(
        `[${executionId}] Failed to unsubscribe: ${error.message}`,
      );
    }
  }

  /**
   * Subscribe to Alchemy WebSocket for transfer events (EVM chains)
   *
   * Monitors alchemy_pendingTransactions and filters by recipient address
   */
  private async subscribeAlchemy(
    executionId: string,
    destChainId: number | string,
    recipient: string,
    tokenAddress: string | undefined,
    expectedMinOutRaw?: string,
    expectedEstOutRaw?: string,
    wsConfig?: WebSocketConfig,
  ): Promise<void> {
    // TODO: Implement Alchemy WebSocket subscription
    // https://docs.alchemy.com/reference/newpendingtransactions
    this.logger.debug(
      `[${executionId}] Alchemy WebSocket subscription (not yet implemented)`,
    );
  }

  /**
   * Subscribe to QuickNode WebSocket (multi-chain support)
   */
  private async subscribeQuicknode(
    executionId: string,
    destChainId: number | string,
    recipient: string,
    tokenAddress: string | undefined,
    expectedMinOutRaw?: string,
    expectedEstOutRaw?: string,
    wsConfig?: WebSocketConfig,
  ): Promise<void> {
    // TODO: Implement QuickNode WebSocket subscription
    this.logger.debug(
      `[${executionId}] QuickNode WebSocket subscription (not yet implemented)`,
    );
  }

  /**
   * Subscribe to Helius WebSocket for Solana transfers
   *
   * Uses accountSubscribe to monitor recipient account changes
   */
  private async subscribeHelius(
    executionId: string,
    destChainId: number | string,
    recipient: string,
    tokenAddress: string | undefined,
    expectedMinOutRaw?: string,
    expectedEstOutRaw?: string,
    wsConfig?: WebSocketConfig,
  ): Promise<void> {
    // TODO: Implement Helius WebSocket subscription
    // https://docs.helius.dev/webhooks-and-websockets/websockets
    this.logger.debug(
      `[${executionId}] Helius WebSocket subscription (not yet implemented)`,
    );
  }

  /**
   * Subscribe to Chainstack WebSocket
   */
  private async subscribeChainstack(
    executionId: string,
    destChainId: number | string,
    recipient: string,
    tokenAddress: string | undefined,
    expectedMinOutRaw?: string,
    expectedEstOutRaw?: string,
    wsConfig?: WebSocketConfig,
  ): Promise<void> {
    // TODO: Implement Chainstack WebSocket subscription
    this.logger.debug(
      `[${executionId}] Chainstack WebSocket subscription (not yet implemented)`,
    );
  }

  /**
   * Handle incoming transfer event from WebSocket
   *
   * @param executionId - Execution ID
   * @param transferData - Transfer event data
   */
  private async handleTransferEvent(
    executionId: string,
    transferData: {
      from: string;
      to: string;
      amount: string;
      txHash: string;
      blockNumber?: number;
    },
  ): Promise<void> {
    this.logger.log(`[${executionId}] Transfer detected via WebSocket`, {
      from: transferData.from,
      to: transferData.to,
      amount: transferData.amount,
      txHash: transferData.txHash,
    });

    // Update execution snapshot with detected transfer
    const snapshot = await this.stateService.getExecutionSnapshot(executionId);
    if (!snapshot?.bridge) {
      return;
    }

    await this.stateService.updateExecutionSnapshot(executionId, {
      bridge: {
        ...snapshot.bridge,
        destTxHash: transferData.txHash,
        status: 'completed',
      } as any,
      overall: 'SUCCESS',
    } as any);

    // Unsubscribe after successful detection
    await this.unsubscribeFromTransfers(executionId);
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Cleanup old subscriptions (should be called periodically)
   */
  cleanupStaleSubscriptions(): void {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    for (const [executionId, subscription] of this.wsSubscriptions.entries()) {
      if (subscription.createdAt && now - subscription.createdAt > maxAge) {
        this.logger.warn(
          `[${executionId}] Cleaning up stale WebSocket subscription`,
        );
        this.unsubscribeFromTransfers(executionId);
      }
    }
  }
}
