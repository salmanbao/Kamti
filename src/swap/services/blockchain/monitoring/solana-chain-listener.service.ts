import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  Connection,
  PublicKey,
  Commitment,
  ParsedTransactionWithMeta,
  ConfirmedSignatureInfo,
} from '@solana/web3.js';
import {
  IChainListener,
  TransactionStatus,
  BalanceChangeEvent,
  TransactionReceipt,
  ConfirmationEvent,
} from './chain-listener.interface';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';

/**
 * Solana Chain Listener
 *
 * Implements transaction monitoring for Solana blockchain.
 * Uses Solana's commitment levels: processed, confirmed, finalized.
 *
 * Requirements:
 * - #4: WebSocket mechanism via onAccountChange subscription
 * - #5: Wait for 1 confirmation (confirmed commitment) for round-trip
 * - #6: Record actual received amount from transaction data
 */
@Injectable()
export class SolanaChainListener implements IChainListener {
  private readonly chainId: string = 'solana-mainnet';
  private readonly ecosystem = 'solana';
  private connection: Connection;
  private subscriptions: Map<string, number> = new Map(); // Maps subscriptionId to Solana subscription ID
  private readonly blockTime = 0.4; // ~400ms per block

  constructor(
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(SolanaChainListener.name);
    this.initializeConnection();
  }

  getEcosystem(): string {
    return this.ecosystem;
  }

  getChainId(): string {
    return this.chainId;
  }

  /**
   * Initialize Solana connection
   */
  private initializeConnection(): void {
    const chainConfig =
      this.unifiedConfig.getChainConfiguration('solana-mainnet');

    if (
      !chainConfig ||
      !chainConfig.rpcUrls ||
      chainConfig.rpcUrls.length === 0
    ) {
      throw new Error('No RPC URLs configured for Solana');
    }

    this.connection = new Connection(chainConfig.rpcUrls[0], 'confirmed');
    this.logger.log('Solana connection initialized');
  }

  /**
   * Watch address for balance changes (requirement #4)
   *
   * Uses onAccountChange subscription for real-time updates
   */
  async watchAddress(
    address: string,
    callback: (event: BalanceChangeEvent) => void,
  ): Promise<string> {
    const subscriptionId = `solana-${address}-${Date.now()}`;

    this.logger.log(`Starting watch on Solana address ${address}`);

    try {
      const publicKey = new PublicKey(address);
      let previousBalance: number | null = null;

      // Subscribe to account changes
      const solanaSubId = this.connection.onAccountChange(
        publicKey,
        (accountInfo, context) => {
          const newBalance = accountInfo.lamports;

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
        },
        'confirmed',
      );

      this.subscriptions.set(subscriptionId, solanaSubId);
      this.logger.log(
        `Subscribed to Solana account ${address} with ID ${solanaSubId}`,
      );

      return subscriptionId;
    } catch (error) {
      this.logger.error(
        `Failed to watch Solana address ${address}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Stop watching address
   */
  async unwatchAddress(subscriptionId: string): Promise<void> {
    const solanaSubId = this.subscriptions.get(subscriptionId);

    if (solanaSubId !== undefined) {
      await this.connection.removeAccountChangeListener(solanaSubId);
      this.subscriptions.delete(subscriptionId);
      this.logger.log(
        `Unsubscribed from Solana subscription ${subscriptionId}`,
      );
    } else {
      this.logger.warn(`No Solana subscription found for ID ${subscriptionId}`);
    }
  }

  /**
   * Wait for transaction confirmations (requirement #5)
   *
   * Solana uses commitment levels instead of block confirmations:
   * - processed: 1 confirmation (~400ms)
   * - confirmed: ~32 confirmations (~13 seconds) - USED FOR ROUND-TRIP
   * - finalized: ~32 confirmations (~13 seconds)
   */
  async waitForConfirmations(
    txHash: string,
    minConfirmations: number,
    callback?: (event: ConfirmationEvent) => void,
  ): Promise<TransactionReceipt> {
    this.logger.log(
      `Waiting for Solana transaction ${txHash} with ${minConfirmations} confirmations`,
    );

    // Map confirmation count to Solana commitment level
    const commitment: Commitment =
      minConfirmations >= 32 ? 'finalized' : 'confirmed';

    // Poll for transaction confirmation
    const maxAttempts = 60; // 60 seconds timeout
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const status = await this.connection.getSignatureStatus(txHash, {
          searchTransactionHistory: true,
        });

        if (status.value) {
          const confirmationStatus = status.value.confirmationStatus;

          // Check if reached desired commitment level
          if (
            (commitment === 'confirmed' &&
              (confirmationStatus === 'confirmed' ||
                confirmationStatus === 'finalized')) ||
            (commitment === 'finalized' && confirmationStatus === 'finalized')
          ) {
            // Fetch full transaction details
            const transaction = await this.connection.getParsedTransaction(
              txHash,
              {
                commitment,
                maxSupportedTransactionVersion: 0,
              },
            );

            if (!transaction) {
              throw new Error(`Transaction ${txHash} not found`);
            }

            const blockTime =
              transaction.blockTime || Math.floor(Date.now() / 1000);
            const timestamp = new Date(blockTime * 1000).toISOString();

            // Emit confirmation event
            if (callback) {
              callback({
                txHash,
                confirmations: commitment === 'finalized' ? 32 : 1,
                blockNumber: transaction.slot,
                blockHash:
                  transaction.transaction.message.recentBlockhash || '',
                timestamp,
                isFinalized: commitment === 'finalized',
              });
            }

            return {
              txHash,
              blockNumber: transaction.slot,
              blockHash: transaction.transaction.message.recentBlockhash || '',
              status: transaction.meta?.err ? 'failed' : 'success',
              gasUsed: transaction.meta?.fee.toString() || '0',
              from: transaction.transaction.message.accountKeys[0].pubkey.toBase58(),
              to:
                transaction.transaction.message.accountKeys[1]?.pubkey.toBase58() ||
                '',
              timestamp,
            };
          }
        }
      } catch (error) {
        this.logger.error(
          `Error checking Solana transaction status: ${error.message}`,
        );
      }

      // Wait 1 second before retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }

    throw new Error(
      `Timeout waiting for Solana transaction ${txHash} confirmation`,
    );
  }

  /**
   * Get transaction status
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      const status = await this.connection.getSignatureStatus(txHash, {
        searchTransactionHistory: true,
      });

      if (!status.value) {
        return {
          txHash,
          status: 'pending',
          confirmations: 0,
        };
      }

      const confirmationStatus = status.value.confirmationStatus;
      let confirmations = 0;

      if (confirmationStatus === 'processed') confirmations = 1;
      else if (confirmationStatus === 'confirmed') confirmations = 1;
      else if (confirmationStatus === 'finalized') confirmations = 32;

      return {
        txHash,
        status: confirmationStatus === 'finalized' ? 'finalized' : 'confirmed',
        confirmations,
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
   * Get transaction receipt
   */
  async getTransactionReceipt(
    txHash: string,
  ): Promise<TransactionReceipt | null> {
    try {
      const transaction = await this.connection.getParsedTransaction(txHash, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction) {
        return null;
      }

      const blockTime = transaction.blockTime || Math.floor(Date.now() / 1000);

      return {
        txHash,
        blockNumber: transaction.slot,
        blockHash: transaction.transaction.message.recentBlockhash || '',
        status: transaction.meta?.err ? 'failed' : 'success',
        gasUsed: transaction.meta?.fee.toString() || '0',
        from: transaction.transaction.message.accountKeys[0].pubkey.toBase58(),
        to:
          transaction.transaction.message.accountKeys[1]?.pubkey.toBase58() ||
          '',
        logs: transaction.meta?.logMessages || [],
        timestamp: new Date(blockTime * 1000).toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get Solana receipt for ${txHash}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get actual received amount from transaction (requirement #6)
   *
   * Parses Solana transaction to determine actual SPL token or SOL amount received
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
    const transaction = await this.connection.getParsedTransaction(txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!transaction) {
      throw new Error(`Solana transaction ${txHash} not found`);
    }

    if (transaction.meta?.err) {
      throw new Error(`Solana transaction ${txHash} failed`);
    }

    const blockTime = transaction.blockTime || Math.floor(Date.now() / 1000);
    const timestamp = new Date(blockTime * 1000).toISOString();

    // If native SOL (wrapped SOL address: So11111111111111111111111111111111111111111)
    if (
      !tokenAddress ||
      tokenAddress === 'So11111111111111111111111111111111111111111'
    ) {
      // Parse SOL balance changes
      const recipientPubkey = new PublicKey(recipientAddress);
      const accountKeys = transaction.transaction.message.accountKeys;

      // Find recipient account index
      const recipientIndex = accountKeys.findIndex(
        (key) => key.pubkey.toBase58() === recipientAddress,
      );

      if (
        recipientIndex !== -1 &&
        transaction.meta?.postBalances &&
        transaction.meta?.preBalances
      ) {
        const preBalance = transaction.meta.preBalances[recipientIndex];
        const postBalance = transaction.meta.postBalances[recipientIndex];
        const change = postBalance - preBalance;

        this.logger.log(
          `✅ Parsed SOL balance change for ${recipientAddress}: ` +
            `pre=${preBalance}, post=${postBalance}, change=${change}`,
        );

        return {
          amount: change.toString(),
          token: 'SOL',
          recipient: recipientAddress,
          blockNumber: transaction.slot,
          timestamp,
        };
      } else {
        this.logger.warn(
          `Could not find recipient ${recipientAddress} in account keys. ` +
            `Recipient index: ${recipientIndex}, Account keys count: ${accountKeys.length}`,
        );
      }
    }

    // Parse SPL token transfers and native SOL transfers
    const instructions = transaction.transaction.message.instructions;

    this.logger.debug(
      `Parsing ${instructions.length} instructions for Solana tx ${txHash}`,
    );

    for (const instruction of instructions) {
      if ('parsed' in instruction && instruction.parsed) {
        const parsed = instruction.parsed;
        const instructionType = parsed.type;

        this.logger.debug(`Found parsed instruction type: ${instructionType}`);

        // Check for SPL token transfer
        if (
          instructionType === 'transfer' ||
          instructionType === 'transferChecked'
        ) {
          const info = parsed.info;

          // Log all destination addresses found
          if (info.destination) {
            this.logger.debug(
              `Found transfer to ${info.destination}, looking for ${recipientAddress}, ` +
                `amount: ${info.amount || info.tokenAmount?.amount || 'N/A'}`,
            );
          }

          if (
            info.destination === recipientAddress &&
            (!tokenAddress || info.mint === tokenAddress)
          ) {
            const amount = info.amount || info.tokenAmount?.amount || '0';
            this.logger.log(
              `✅ Parsed ${instructionType} instruction: ${amount} to ${recipientAddress}`,
            );
            return {
              amount,
              token: tokenAddress || info.mint || 'UNKNOWN',
              recipient: recipientAddress,
              blockNumber: transaction.slot,
              timestamp,
            };
          }
        }

        // Also check for transferWithSeed and other SOL transfer types
        if (
          instructionType === 'transferWithSeed' ||
          instructionType === 'transferWithSeedChecked'
        ) {
          const info = parsed.info;
          if (info.destination === recipientAddress) {
            const amount = info.amount || info.lamports || '0';
            this.logger.log(
              `✅ Parsed ${instructionType} instruction: ${amount} to ${recipientAddress}`,
            );
            return {
              amount: amount.toString(),
              token: 'SOL',
              recipient: recipientAddress,
              blockNumber: transaction.slot,
              timestamp,
            };
          }
        }
      }
    }

    // Check inner instructions (often where actual transfers happen in cross-chain swaps)
    if (transaction.meta?.innerInstructions) {
      this.logger.debug(
        `Checking ${transaction.meta.innerInstructions.length} inner instruction groups`,
      );

      for (const innerGroup of transaction.meta.innerInstructions) {
        for (const innerInstruction of innerGroup.instructions) {
          if ('parsed' in innerInstruction && innerInstruction.parsed) {
            const parsed = innerInstruction.parsed;
            const instructionType = parsed.type;

            this.logger.debug(
              `Found inner instruction type: ${instructionType}`,
            );

            if (
              instructionType === 'transfer' ||
              instructionType === 'transferChecked'
            ) {
              const info = parsed.info;

              if (info.destination) {
                this.logger.debug(
                  `Found inner transfer to ${info.destination}, amount: ${info.amount || info.tokenAmount?.amount || 'N/A'}`,
                );
              }

              if (
                info.destination === recipientAddress &&
                (!tokenAddress || info.mint === tokenAddress)
              ) {
                const amount = info.amount || info.tokenAmount?.amount || '0';
                this.logger.log(
                  `✅ Parsed inner ${instructionType} instruction: ${amount} to ${recipientAddress}`,
                );
                return {
                  amount,
                  token: tokenAddress || info.mint || 'SOL',
                  recipient: recipientAddress,
                  blockNumber: transaction.slot,
                  timestamp,
                };
              }
            }
          }
        }
      }
    }

    this.logger.error(
      `❌ Could not parse received amount for Solana tx ${txHash}. ` +
        `Recipient: ${recipientAddress}, Token: ${tokenAddress || 'SOL'}. ` +
        `No matching transfer found in transaction instructions.`,
    );

    // Throw error to trigger fallback to balance delta strategy
    throw new Error(
      `Failed to parse received amount for Solana transaction ${txHash}. ` +
        `No transfer instruction found for recipient ${recipientAddress}.`,
    );
  }

  /**
   * Get current block number (slot)
   */
  async getCurrentBlockNumber(): Promise<number> {
    return await this.connection.getSlot('confirmed');
  }

  /**
   * Estimate confirmation time
   */
  estimateConfirmationTime(confirmations: number): number {
    // Solana has ~400ms block time, but commitment levels are different
    if (confirmations >= 32) return 13; // Finalized
    return 1; // Confirmed (1 block ~400ms, but commitment level is ~1s)
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.connection.getSlot();
      return true;
    } catch (error) {
      this.logger.error(`Solana health check failed: ${error.message}`);
      return false;
    }
  }
}
