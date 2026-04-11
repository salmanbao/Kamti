import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  IChainListener,
  TransactionStatus,
  BalanceChangeEvent,
  TransactionReceipt,
  ConfirmationEvent,
} from './chain-listener.interface';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * Bitcoin Chain Listener
 *
 * Implements transaction monitoring for Bitcoin and Bitcoin-based chains.
 * Uses blockchain explorers API (Blockchair, Blockchain.com) due to UTXO model.
 *
 * Requirements:
 * - #4: Polling mechanism for UTXO-based transaction monitoring
 * - #5: Wait for 3 confirmations for Bitcoin round-trip swaps
 * - #6: Record actual received amount by summing UTXO outputs
 *
 * Note: Bitcoin does not support WebSocket subscriptions natively,
 * so we use HTTP polling with blockchain explorer APIs.
 */
@Injectable()
export class BitcoinChainListener implements IChainListener {
  private readonly chainId: string = 'bitcoin-mainnet';
  private readonly ecosystem = 'bitcoin';
  private readonly blockTime = 600; // 10 minutes average
  private subscriptions: Map<string, NodeJS.Timeout> = new Map();
  private readonly apiBaseUrl = 'https://blockchain.info'; // Blockchain.com API

  constructor(
    private readonly httpService: HttpService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(BitcoinChainListener.name);
  }

  getEcosystem(): string {
    return this.ecosystem;
  }

  getChainId(): string {
    return this.chainId;
  }

  /**
   * Watch Bitcoin address for UTXO changes
   *
   * Uses polling since Bitcoin doesn't support WebSocket subscriptions
   */
  async watchAddress(
    address: string,
    callback: (event: BalanceChangeEvent) => void,
  ): Promise<string> {
    const subscriptionId = `bitcoin-${address}-${Date.now()}`;

    this.logger.log(
      `Starting watch on Bitcoin address ${address} (polling mode)`,
    );

    let previousBalance: number | null = null;

    const intervalId = setInterval(async () => {
      try {
        // Fetch address balance from blockchain.info API
        const response = await firstValueFrom(
          this.httpService.get(`${this.apiBaseUrl}/balance?active=${address}`),
        );

        const addressData = response.data[address];
        if (!addressData) {
          return;
        }

        const newBalance = addressData.final_balance; // Balance in satoshis

        if (previousBalance !== null && newBalance !== previousBalance) {
          const change = newBalance - previousBalance;

          callback({
            address,
            previousBalance: previousBalance.toString(),
            newBalance: newBalance.toString(),
            change: change.toString(),
          });
        }

        previousBalance = newBalance;
      } catch (error) {
        this.logger.error(
          `Bitcoin polling watch error for ${address}: ${error.message}`,
        );
      }
    }, 30000); // Poll every 30 seconds (Bitcoin blocks are ~10 min)

    this.subscriptions.set(subscriptionId, intervalId);
    return subscriptionId;
  }

  /**
   * Stop watching address
   */
  async unwatchAddress(subscriptionId: string): Promise<void> {
    const intervalId = this.subscriptions.get(subscriptionId);

    if (intervalId) {
      clearInterval(intervalId);
      this.subscriptions.delete(subscriptionId);
      this.logger.log(
        `Stopped watching Bitcoin subscription ${subscriptionId}`,
      );
    } else {
      this.logger.warn(
        `No Bitcoin subscription found for ID ${subscriptionId}`,
      );
    }
  }

  /**
   * Wait for Bitcoin transaction confirmations (requirement #5)
   *
   * Bitcoin requires 3 confirmations minimum for round-trip swaps (~30 minutes)
   */
  async waitForConfirmations(
    txHash: string,
    minConfirmations: number,
    callback?: (event: ConfirmationEvent) => void,
  ): Promise<TransactionReceipt> {
    this.logger.log(
      `Waiting for ${minConfirmations} Bitcoin confirmations for tx ${txHash}`,
    );

    const maxAttempts = 120; // 60 minutes timeout (polling every 30s)
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const status = await this.getTransactionStatus(txHash);

        if (status.confirmations >= minConfirmations) {
          // Fetch full transaction receipt
          const receipt = await this.getTransactionReceipt(txHash);

          if (!receipt) {
            throw new Error(`Bitcoin transaction ${txHash} not found`);
          }

          // Emit confirmation event
          if (callback) {
            callback({
              txHash,
              confirmations: status.confirmations,
              blockNumber: status.blockNumber || 0,
              blockHash: status.blockHash || '',
              timestamp: receipt.timestamp,
              isFinalized: status.confirmations >= 6,
            });
          }

          return receipt;
        }
      } catch (error) {
        this.logger.error(
          `Error checking Bitcoin transaction status: ${error.message}`,
        );
      }

      // Wait 30 seconds before retry
      await new Promise((resolve) => setTimeout(resolve, 30000));
      attempts++;
    }

    throw new Error(
      `Timeout waiting for Bitcoin transaction ${txHash} confirmation`,
    );
  }

  /**
   * Get Bitcoin transaction status
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      // Fetch transaction from blockchain.info
      const response = await firstValueFrom(
        this.httpService.get(`${this.apiBaseUrl}/rawtx/${txHash}`),
      );

      const tx = response.data;

      // Get current block height
      const latestBlockResponse = await firstValueFrom(
        this.httpService.get(`${this.apiBaseUrl}/latestblock`),
      );
      const latestBlockHeight = latestBlockResponse.data.height;

      const confirmations = tx.block_height
        ? latestBlockHeight - tx.block_height + 1
        : 0;

      return {
        txHash,
        status: confirmations > 0 ? 'confirmed' : 'pending',
        confirmations,
        blockNumber: tx.block_height,
        blockHash: tx.block_hash,
      };
    } catch (error) {
      return {
        txHash,
        status: 'failed',
        confirmations: 0,
        error: error.message,
      };
    }
  }

  /**
   * Get Bitcoin transaction receipt
   */
  async getTransactionReceipt(
    txHash: string,
  ): Promise<TransactionReceipt | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.apiBaseUrl}/rawtx/${txHash}`),
      );

      const tx = response.data;

      // Get current block height for confirmations
      const latestBlockResponse = await firstValueFrom(
        this.httpService.get(`${this.apiBaseUrl}/latestblock`),
      );
      const latestBlockHeight = latestBlockResponse.data.height;

      const confirmations = tx.block_height
        ? latestBlockHeight - tx.block_height + 1
        : 0;

      return {
        txHash,
        blockNumber: tx.block_height || 0,
        blockHash: tx.block_hash || '',
        status: confirmations > 0 ? 'success' : 'failed',
        gasUsed: tx.fee?.toString() || '0', // Bitcoin fee
        from: tx.inputs?.[0]?.prev_out?.addr || 'unknown',
        to: tx.out?.[0]?.addr || 'unknown',
        timestamp: tx.time
          ? new Date(tx.time * 1000).toISOString()
          : new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get Bitcoin receipt for ${txHash}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get actual received amount from Bitcoin transaction (requirement #6)
   *
   * Sums all UTXO outputs to the recipient address
   */
  async getActualReceivedAmount(
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
    const response = await firstValueFrom(
      this.httpService.get(`${this.apiBaseUrl}/rawtx/${txHash}`),
    );

    const tx = response.data;

    if (!tx.out || tx.out.length === 0) {
      throw new Error(`No outputs found in Bitcoin transaction ${txHash}`);
    }

    // Sum all outputs to recipient address
    let totalAmount = 0;

    for (const output of tx.out) {
      if (output.addr === recipientAddress) {
        totalAmount += output.value; // Value in satoshis
      }
    }

    this.logger.log(
      `Parsed Bitcoin received amount for ${recipientAddress}: ${totalAmount} satoshis`,
    );

    return {
      amount: totalAmount.toString(),
      token: 'BTC',
      recipient: recipientAddress,
      blockNumber: tx.block_height || 0,
      timestamp: tx.time
        ? new Date(tx.time * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  /**
   * Get current Bitcoin block height
   */
  async getCurrentBlockNumber(): Promise<number> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.apiBaseUrl}/latestblock`),
      );
      return response.data.height;
    } catch (error) {
      this.logger.error(
        `Failed to get current Bitcoin block: ${error.message}`,
      );
      return 0;
    }
  }

  /**
   * Estimate confirmation time for Bitcoin
   */
  estimateConfirmationTime(confirmations: number): number {
    return this.blockTime * confirmations; // ~10 minutes per confirmation
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.getCurrentBlockNumber();
      return true;
    } catch (error) {
      this.logger.error(`Bitcoin health check failed: ${error.message}`);
      return false;
    }
  }
}
