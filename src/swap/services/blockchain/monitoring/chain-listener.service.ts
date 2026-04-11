import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  IChainListener,
  TransactionStatus,
  TransactionReceipt,
  BalanceChangeEvent,
  ConfirmationEvent,
} from './chain-listener.interface';
import { EVMChainListener } from './evm-chain-listener.service';
import { SolanaChainListener } from './solana-chain-listener.service';
import { BitcoinChainListener } from './bitcoin-chain-listener.service';
import { TronChainListener } from './tron-chain-listener.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { HttpService } from '@nestjs/axios';
import { getRoundTripMinConfirmations } from '@shared/config/confirmation-requirements.config';

/**
 * Chain Listener Service
 *
 * Factory and orchestrator for chain-specific listeners.
 * Provides unified interface for multi-chain transaction monitoring.
 *
 * Requirements:
 * - #4: Modular and abstract WebSocket mechanism for all chains
 * - #5: Enforce minimum confirmations per ecosystem (EVM=1, Solana=1, Bitcoin=3)
 * - #6: Record actual received amounts across all chains
 */
@Injectable()
export class ChainListenerService {
  private listeners: Map<string, IChainListener> = new Map();

  constructor(
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly httpService: HttpService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(ChainListenerService.name);
  }

  /**
   * Get chain listener for specific chain
   *
   * Creates listener instance if not already cached.
   *
   * @param chainId - Chain identifier (number for EVM, string for others)
   * @param ecosystem - Blockchain ecosystem
   * @returns Chain-specific listener implementation
   */
  getChainListener(
    chainId: number | string,
    ecosystem: string,
  ): IChainListener {
    const key = `${ecosystem}-${chainId}`;

    if (this.listeners.has(key)) {
      return this.listeners.get(key)!;
    }

    let listener: IChainListener;

    const normalizedEcosystem = ecosystem.toLowerCase();

    switch (normalizedEcosystem) {
      case 'evm':
      case 'ethereum':
      case 'polygon':
      case 'bsc':
      case 'arbitrum':
      case 'optimism':
      case 'avalanche':
      case 'base':
        listener = new EVMChainListener(
          Number(chainId),
          this.unifiedConfig,
          this.logger,
        );
        break;

      case 'solana':
        listener = new SolanaChainListener(this.unifiedConfig, this.logger);
        break;

      case 'bitcoin':
      case 'btc':
        listener = new BitcoinChainListener(this.httpService, this.logger);
        break;

      case 'tron':
        listener = new TronChainListener(
          this.httpService,
          this.unifiedConfig,
          this.logger,
        );
        break;

      default:
        throw new Error(
          `Unsupported ecosystem for transaction monitoring: ${ecosystem}`,
        );
    }

    this.listeners.set(key, listener);
    this.logger.log(`Created chain listener for ${ecosystem}:${chainId}`);

    return listener;
  }

  /**
   * Watch address across any chain (requirement #4)
   *
   * @param chainId - Chain identifier
   * @param ecosystem - Blockchain ecosystem
   * @param address - Address to monitor
   * @param callback - Callback for balance change events
   * @returns Subscription ID for cleanup
   */
  async watchAddress(
    chainId: number | string,
    ecosystem: string,
    address: string,
    callback: (event: BalanceChangeEvent) => void,
  ): Promise<string> {
    const listener = this.getChainListener(chainId, ecosystem);
    return await listener.watchAddress(address, callback);
  }

  /**
   * Stop watching address
   *
   * @param chainId - Chain identifier
   * @param ecosystem - Blockchain ecosystem
   * @param subscriptionId - Subscription ID from watchAddress
   */
  async unwatchAddress(
    chainId: number | string,
    ecosystem: string,
    subscriptionId: string,
  ): Promise<void> {
    const listener = this.getChainListener(chainId, ecosystem);
    await listener.unwatchAddress(subscriptionId);
  }

  /**
   * Wait for transaction confirmations with ecosystem-specific minimums (requirement #5)
   *
   * Automatically applies correct minimum confirmations:
   * - EVM: 1 confirmation
   * - Solana: 1 confirmation
   * - Bitcoin: 3 confirmations
   *
   * @param chainId - Chain identifier
   * @param ecosystem - Blockchain ecosystem
   * @param txHash - Transaction hash
   * @param minConfirmations - Optional override (uses ecosystem default if not provided)
   * @param callback - Optional callback for each confirmation
   * @returns Transaction receipt after confirmations reached
   */
  async waitForConfirmations(
    chainId: number | string,
    ecosystem: string,
    txHash: string,
    minConfirmations?: number,
    callback?: (event: ConfirmationEvent) => void,
  ): Promise<TransactionReceipt> {
    const listener = this.getChainListener(chainId, ecosystem);

    // Use ecosystem-specific minimum if not overridden (requirement #5)
    const confirmationsRequired =
      minConfirmations ?? getRoundTripMinConfirmations(ecosystem);

    this.logger.log(
      `Waiting for ${confirmationsRequired} confirmations on ${ecosystem}:${chainId} for tx ${txHash}`,
    );

    return await listener.waitForConfirmations(
      txHash,
      confirmationsRequired,
      callback,
    );
  }

  /**
   * Get transaction status
   */
  async getTransactionStatus(
    chainId: number | string,
    ecosystem: string,
    txHash: string,
  ): Promise<TransactionStatus> {
    const listener = this.getChainListener(chainId, ecosystem);
    return await listener.getTransactionStatus(txHash);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(
    chainId: number | string,
    ecosystem: string,
    txHash: string,
  ): Promise<TransactionReceipt | null> {
    const listener = this.getChainListener(chainId, ecosystem);
    return await listener.getTransactionReceipt(txHash);
  }

  /**
   * Get actual received amount from transaction (requirement #6)
   *
   * Critical for round-trip swaps: uses ACTUAL on-chain amount, not estimates.
   * Parses chain-specific transaction data:
   * - EVM: Transfer event logs
   * - Solana: SPL token transfer instructions
   * - Bitcoin: UTXO outputs
   *
   * @param chainId - Chain identifier
   * @param ecosystem - Blockchain ecosystem
   * @param txHash - Transaction hash
   * @param recipientAddress - Recipient address
   * @param tokenAddress - Token address (undefined for native tokens)
   * @returns Actual received amount with metadata
   */
  async getActualReceivedAmount(
    chainId: number | string,
    ecosystem: string,
    txHash: string,
    recipientAddress: string,
    tokenAddress?: string,
  ): Promise<{
    amount: string;
    token: string;
    recipient: string;
    blockNumber: number;
    timestamp: string;
  }> {
    const listener = this.getChainListener(chainId, ecosystem);

    this.logger.log(
      `Getting actual received amount for ${ecosystem}:${chainId} tx ${txHash}`,
    );

    return await listener.getActualReceivedAmount(
      txHash,
      recipientAddress,
      tokenAddress,
    );
  }

  /**
   * Get current block number for chain
   */
  async getCurrentBlockNumber(
    chainId: number | string,
    ecosystem: string,
  ): Promise<number> {
    const listener = this.getChainListener(chainId, ecosystem);
    return await listener.getCurrentBlockNumber();
  }

  /**
   * Estimate confirmation time
   */
  estimateConfirmationTime(
    chainId: number | string,
    ecosystem: string,
    confirmations: number,
  ): number {
    const listener = this.getChainListener(chainId, ecosystem);
    return listener.estimateConfirmationTime(confirmations);
  }

  /**
   * Health check for chain listener
   */
  async isChainHealthy(
    chainId: number | string,
    ecosystem: string,
  ): Promise<boolean> {
    try {
      const listener = this.getChainListener(chainId, ecosystem);
      return await listener.isHealthy();
    } catch (error) {
      this.logger.error(
        `Health check failed for ${ecosystem}:${chainId}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Cleanup all listeners (call on application shutdown)
   */
  async cleanup(): Promise<void> {
    this.logger.log('Cleaning up chain listeners...');

    for (const [key, listener] of this.listeners.entries()) {
      try {
        // Cleanup would go here if needed
        this.logger.log(`Cleaned up listener ${key}`);
      } catch (error) {
        this.logger.error(
          `Error cleaning up listener ${key}: ${error.message}`,
        );
      }
    }

    this.listeners.clear();
  }
}
