import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import * as TronWebModule from 'tronweb';
import { HttpService } from '@nestjs/axios';
import {
  IChainListener,
  TransactionStatus,
  BalanceChangeEvent,
  TransactionReceipt,
  ConfirmationEvent,
} from './chain-listener.interface';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';

// Extract TronWeb from module
const TronWeb = (TronWebModule as any).TronWeb || TronWebModule;

/**
 * Tron Chain Listener
 *
 * Implements transaction monitoring for TRON blockchain using TronWeb library.
 *
 * Requirements:
 * - #4: Polling mechanism for listening to receiver address balance changes
 * - #5: Wait for minimum confirmations (1 for round-trip, 19 for finality)
 * - #6: Record actual received amount from transaction logs
 *
 * TRON Specifics:
 * - Block time: ~3 seconds
 * - 1 TRX = 1,000,000 SUN (smallest unit)
 * - Transaction types: TransferContract (native TRX), TriggerSmartContract (TRC-20), TransferAssetContract (TRC-10)
 * - Uses TronWeb library for all blockchain interactions
 */
@Injectable()
export class TronChainListener implements IChainListener {
  private readonly chainId: string = 'tron-mainnet';
  private readonly ecosystem = 'tron';
  private readonly blockTime = 3; // 3 seconds average for TRON
  private tronWeb: InstanceType<typeof TronWeb>;
  private subscriptions: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private readonly httpService: HttpService,
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(TronChainListener.name);
    this.initializeTronWeb();
  }

  getEcosystem(): string {
    return this.ecosystem;
  }

  getChainId(): string {
    return this.chainId;
  }

  /**
   * Initialize TronWeb instance with RPC configuration
   */
  private initializeTronWeb(): void {
    const chainConfig = this.unifiedConfig.getChainConfiguration(this.chainId);
    if (!chainConfig) {
      throw new Error(
        `Chain configuration not found for Tron chain ${this.chainId}`,
      );
    }

    const rpcUrls = chainConfig.rpcUrls || [];
    const fullHost =
      rpcUrls.length > 0 ? rpcUrls[0] : 'https://api.trongrid.io';

    this.tronWeb = new TronWeb({
      fullHost,
      // No private key needed for read-only operations
    });

    this.logger.log(`TronWeb initialized with fullHost: ${fullHost}`);
  }

  /**
   * Watch address for balance changes (polling-based)
   *
   * Since TRON doesn't have native WebSocket support like EVM chains,
   * we use polling to detect balance changes.
   */
  async watchAddress(
    address: string,
    callback: (event: BalanceChangeEvent) => void,
  ): Promise<string> {
    const subscriptionId = `tron-${address}-${Date.now()}`;
    let previousBalance: string | null = null;

    this.logger.log(`Starting balance monitoring for Tron address ${address}`);

    const pollBalance = async () => {
      try {
        const balance = await this.tronWeb.trx.getBalance(address);
        const balanceStr = balance.toString();

        if (previousBalance !== null && balanceStr !== previousBalance) {
          const change = BigInt(balanceStr) - BigInt(previousBalance);

          this.logger.log(
            `Balance change detected for ${address}: ${previousBalance} → ${balanceStr} (Δ ${change})`,
          );

          callback({
            address,
            previousBalance,
            newBalance: balanceStr,
            change: change.toString(),
          });
        }

        previousBalance = balanceStr;
      } catch (error) {
        this.logger.error(
          `Error polling Tron balance for ${address}: ${error.message}`,
        );
      }
    };

    // Poll every 5 seconds
    const interval = setInterval(pollBalance, 5000);
    this.subscriptions.set(subscriptionId, interval);

    // Initial balance check
    await pollBalance();

    return subscriptionId;
  }

  /**
   * Stop watching address
   */
  async unwatchAddress(subscriptionId: string): Promise<void> {
    const interval = this.subscriptions.get(subscriptionId);

    if (interval) {
      clearInterval(interval);
      this.subscriptions.delete(subscriptionId);
      this.logger.log(
        `Stopped watching Tron address (subscription ${subscriptionId})`,
      );
    }
  }

  /**
   * Wait for transaction confirmations
   *
   * Polls transaction status until it reaches the desired number of confirmations.
   * Confirmations = currentBlock - txBlock + 1
   */
  async waitForConfirmations(
    txHash: string,
    minConfirmations: number,
    callback?: (event: ConfirmationEvent) => void,
  ): Promise<TransactionReceipt> {
    this.logger.log(
      `Waiting for ${minConfirmations} confirmation(s) for Tron tx ${txHash}`,
    );

    const maxAttempts = 60; // 60 attempts * 2 seconds = 2 minutes timeout
    let attempts = 0;
    let confirmations = 0;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        // Get transaction info
        const txInfo: any = await this.tronWeb.trx.getTransactionInfo(txHash);

        if (!txInfo || !txInfo.blockNumber) {
          this.logger.debug(
            `Tron tx ${txHash} not yet in a block (attempt ${attempts}/${maxAttempts})`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        // Get current block number
        const currentBlock = await this.tronWeb.trx.getCurrentBlock();
        const currentBlockNumber = currentBlock.block_header.raw_data.number;

        // Calculate confirmations
        confirmations = currentBlockNumber - txInfo.blockNumber + 1;

        this.logger.debug(
          `Tron tx ${txHash}: block ${txInfo.blockNumber}, current ${currentBlockNumber}, confirmations ${confirmations}`,
        );

        // Emit confirmation event
        if (callback) {
          callback({
            txHash,
            confirmations,
            blockNumber: txInfo.blockNumber,
            blockHash: txInfo.id || txHash, // Use transaction ID as block hash fallback
            timestamp: new Date(txInfo.blockTimeStamp).toISOString(),
            isFinalized: confirmations >= minConfirmations,
          });
        }

        if (confirmations >= minConfirmations) {
          this.logger.log(
            `✅ Tron tx ${txHash} reached ${confirmations} confirmation(s)`,
          );
          const receipt = await this.getTransactionReceipt(txHash);
          if (!receipt) {
            throw new Error(
              `Transaction receipt not found for ${txHash} after confirmations`,
            );
          }
          return receipt;
        }
      } catch (error) {
        this.logger.warn(
          `Error checking Tron confirmations (attempt ${attempts}): ${error.message}`,
        );
      }

      // Wait 2 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(
      `Timeout waiting for Tron transaction confirmations. ` +
        `Got ${confirmations}/${minConfirmations} after ${attempts} attempts`,
    );
  }

  /**
   * Get Tron transaction status
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      // Try to get transaction status without waiting if pending
      let txInfo: any = await this.tronWeb.trx.getTransactionInfo(txHash);

      if (!txInfo || !txInfo.blockNumber) {
        // Try once more after a short delay in case it was just submitted
        await new Promise((resolve) => setTimeout(resolve, 1000));
        txInfo = await this.tronWeb.trx.getTransactionInfo(txHash);
        if (!txInfo || !txInfo.blockNumber) {
          return {
            txHash,
            status: 'pending',
            confirmations: 0,
          };
        }
      }

      // Check transaction result from receipt or transaction status
      const receipt = txInfo.receipt;
      let status: 'confirmed' | 'failed' = 'confirmed';

      // For smart contracts, check receipt.result if available
      this.logger.debug(`Transaction ${txHash} receipt status check`, {
        hasReceipt: !!receipt,
        receiptResult: receipt?.result,
        receiptKeys: receipt ? Object.keys(receipt) : [],
      });

      if (receipt?.result) {
        this.logger.debug(`Receipt result detected: ${receipt.result}`);
        if (receipt.result === 'REVERT' || receipt.result === 'OUT_OF_ENERGY') {
          // Smart contract execution failed
          status = 'failed';
        } else if (receipt.result !== 'SUCCESS') {
          // Other unknown receipt results for investigation
          this.logger.warn(
            `Unknown receipt result: ${receipt.result} for tx ${txHash}`,
          );
          status = 'failed';
        }
      }

      // Calculate confirmations
      const currentBlock = await this.tronWeb.trx.getCurrentBlock();
      const currentBlockNumber = currentBlock.block_header.raw_data.number;
      const confirmations = currentBlockNumber - txInfo.blockNumber + 1;

      return {
        txHash,
        status,
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
  /**
   * Wait for transaction confirmation before fetching details
   * Critical because getTransactionInfo() returns incomplete data until confirmed
   */
  private async waitForTransactionConfirmation(
    txHash: string,
    maxWaitTimeMs: number = 120000,
    pollIntervalMs: number = 3000,
  ): Promise<[any, any]> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startTime < maxWaitTimeMs) {
      try {
        const [transaction, txInfo]: [any, any] = await Promise.all([
          this.tronWeb.trx.getTransaction(txHash),
          this.tronWeb.trx.getTransactionInfo(txHash),
        ]);

        // Check if transaction is confirmed (has blockNumber)
        if (transaction && txInfo && txInfo.blockNumber) {
          this.logger.log(
            `✅ Transaction ${txHash} confirmed at block ${txInfo.blockNumber} after ${Date.now() - startTime}ms`,
          );
          return [transaction, txInfo];
        }

        // Transaction found but not yet confirmed
        if (transaction && !txInfo?.blockNumber) {
          this.logger.debug(
            `⏳ Transaction ${txHash} submitted but not yet confirmed. Retrying in ${pollIntervalMs}ms...`,
          );
        }
      } catch (error) {
        lastError = error as Error;
        this.logger.debug(
          `Transaction ${txHash} fetch attempt failed: ${lastError.message}`,
        );
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout reached
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    throw new Error(
      `Tron transaction ${txHash} failed to confirm within ${elapsedSeconds.toFixed(1)}s. ` +
        `${lastError ? `Last error: ${lastError.message}` : 'Transaction data incomplete.'}`,
    );
  }

  async getTransactionReceipt(
    txHash: string,
  ): Promise<TransactionReceipt | null> {
    try {
      // Wait for transaction confirmation before fetching details
      const [transaction, txInfo] =
        await this.waitForTransactionConfirmation(txHash);

      if (!transaction || !txInfo || !txInfo.blockNumber) {
        return null;
      }

      // Determine status from receipt and transaction
      const receipt = txInfo.receipt;
      let status: 'success' | 'failed' = 'success';

      // For smart contracts, check receipt.result
      if (receipt?.result === 'REVERT' || receipt?.result === 'OUT_OF_ENERGY') {
        status = 'failed';
      }

      // Also check transaction contract return status (if available)
      if (transaction.ret && transaction.ret[0]?.contractRet !== 'SUCCESS') {
        status = 'failed';
      }

      // For native transfers, the transaction succeeding to this point means it was successful
      // Tron includes failed transactions differently

      // Extract addresses from transaction
      const contract = transaction.raw_data?.contract?.[0];
      const contractValue = contract?.parameter?.value || {};
      const ownerAddress = contractValue.owner_address || '';
      const toAddress =
        contractValue.to_address || contractValue.contract_address || '';

      // Get fee from transaction contract parameter, not from getTransactionInfo
      const fee = (transaction.raw_data?.fee || 0).toString();

      return {
        txHash,
        blockNumber: txInfo.blockNumber,
        blockHash: txInfo.id || txHash, // Use transaction ID as fallback (Tron uses id instead of blockHash)
        status,
        gasUsed: fee, // Tron uses flat fee, not gas-based
        from: ownerAddress ? this.tronWeb.address.fromHex(ownerAddress) : '',
        to: toAddress ? this.tronWeb.address.fromHex(toAddress) : '',
        logs: txInfo.log || [],
        timestamp: new Date(txInfo.blockTimeStamp).toISOString(),
        value: this.extractTransferAmount(transaction),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get Tron receipt for ${txHash}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Extract transfer amount from transaction
   * Handles native TRX transfers (TransferContract)
   */
  private extractTransferAmount(transaction: any): string {
    try {
      const contract = transaction.raw_data?.contract?.[0];
      const contractValue = contract?.parameter?.value || {};

      // Native TRX transfer
      if (contract?.type === 'TransferContract') {
        return contractValue.amount?.toString() || '0';
      }

      // For smart contract calls, amount is not in the transaction itself
      return '0';
    } catch (error) {
      return '0';
    }
  }

  /**
   * Get actual received amount from transaction (requirement #6)
   *
   * Parses Tron transaction to extract the actual amount received by the recipient.
   * Handles:
   * - TransferContract: Native TRX transfers
   * - TriggerSmartContract: TRC-20 token transfers (via Transfer event logs)
   * - TransferAssetContract: TRC-10 token transfers
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
    // Wait for transaction confirmation before fetching details
    const [transaction, txInfo] =
      await this.waitForTransactionConfirmation(txHash);

    if (!transaction || !txInfo) {
      throw new Error(`Tron transaction ${txHash} not found`);
    }

    if (!txInfo.blockNumber) {
      throw new Error(`Tron transaction ${txHash} not yet confirmed`);
    }

    const contract = transaction.raw_data?.contract?.[0];
    const contractType = contract?.type;
    const timestamp = new Date(txInfo.blockTimeStamp).toISOString();

    // Strategy 1: Native TRX transfer (TransferContract)
    if (contractType === 'TransferContract') {
      const contractValue = contract.parameter?.value || {};
      const toAddress = contractValue.to_address;
      const amount = contractValue.amount;

      if (!toAddress || !amount) {
        throw new Error(`Invalid TransferContract structure for tx ${txHash}`);
      }

      const toAddressBase58 = this.tronWeb.address.fromHex(toAddress);

      // Verify this transfer is to our recipient
      if (
        this.normalizeAddress(toAddressBase58) !==
        this.normalizeAddress(recipientAddress)
      ) {
        this.logger.warn(
          `Transfer recipient mismatch: expected ${recipientAddress}, got ${toAddressBase58}`,
        );
      }

      this.logger.log(
        `✅ Parsed native TRX transfer: ${amount} SUN to ${toAddressBase58} in tx ${txHash}`,
      );

      return {
        amount: amount.toString(),
        token: 'NATIVE',
        recipient: toAddressBase58,
        blockNumber: txInfo.blockNumber,
        timestamp,
      };
    }

    // Strategy 2: TRC-20 token transfer (TriggerSmartContract with Transfer event)
    if (contractType === 'TriggerSmartContract' && tokenAddress) {
      const logs = txInfo.log || [];

      // Transfer event signature: keccak256("Transfer(address,address,uint256)")
      const transferEventSig =
        'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

      for (const log of logs) {
        if (!log.topics || log.topics.length === 0) continue;

        // Check if this is a Transfer event
        if (log.topics[0] === transferEventSig) {
          // topics[1] = from (indexed), topics[2] = to (indexed), data = amount
          if (log.topics.length >= 3 && log.data) {
            const toAddressHex = '41' + log.topics[2].slice(24); // Remove padding, add Tron prefix
            const toAddressBase58 = this.tronWeb.address.fromHex(toAddressHex);

            // Parse amount from data field
            const amount = BigInt('0x' + log.data).toString();

            if (
              this.normalizeAddress(toAddressBase58) ===
              this.normalizeAddress(recipientAddress)
            ) {
              this.logger.log(
                `✅ Parsed TRC-20 transfer: ${amount} tokens (${tokenAddress}) to ${toAddressBase58} in tx ${txHash}`,
              );

              return {
                amount,
                token: tokenAddress,
                recipient: toAddressBase58,
                blockNumber: txInfo.blockNumber,
                timestamp,
              };
            }
          }
        }
      }

      throw new Error(
        `No TRC-20 Transfer event found for recipient ${recipientAddress} in tx ${txHash}`,
      );
    }

    // Strategy 3: TRC-10 token transfer (TransferAssetContract)
    if (contractType === 'TransferAssetContract') {
      const contractValue = contract.parameter?.value || {};
      const toAddress = contractValue.to_address;
      const amount = contractValue.amount;
      const assetName = contractValue.asset_name;

      if (!toAddress || !amount) {
        throw new Error(
          `Invalid TransferAssetContract structure for tx ${txHash}`,
        );
      }

      const toAddressBase58 = this.tronWeb.address.fromHex(toAddress);

      if (
        this.normalizeAddress(toAddressBase58) !==
        this.normalizeAddress(recipientAddress)
      ) {
        this.logger.warn(
          `TRC-10 transfer recipient mismatch: expected ${recipientAddress}, got ${toAddressBase58}`,
        );
      }

      this.logger.log(
        `✅ Parsed TRC-10 transfer: ${amount} ${assetName} to ${toAddressBase58} in tx ${txHash}`,
      );

      return {
        amount: amount.toString(),
        token: `TRC-10:${assetName}`,
        recipient: toAddressBase58,
        blockNumber: txInfo.blockNumber,
        timestamp,
      };
    }

    throw new Error(
      `Unsupported Tron contract type: ${contractType} for tx ${txHash}. ` +
        `Expected TransferContract, TriggerSmartContract, or TransferAssetContract.`,
    );
  }

  /**
   * Get current block number
   */
  async getCurrentBlockNumber(): Promise<number> {
    const currentBlock = await this.tronWeb.trx.getCurrentBlock();
    return currentBlock.block_header.raw_data.number;
  }

  /**
   * Estimate time to reach N confirmations
   */
  estimateConfirmationTime(confirmations: number): number {
    return confirmations * this.blockTime;
  }

  /**
   * Check if Tron chain listener is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.getCurrentBlockNumber();
      return true;
    } catch (error) {
      this.logger.error(
        `Health check failed for Tron chain ${this.chainId}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Normalize Tron address (handles both base58 and hex formats)
   */
  private normalizeAddress(address: string): string {
    if (!address) return '';

    // If it's hex format, convert to base58
    if (address.startsWith('41') && address.length === 42) {
      return this.tronWeb.address.fromHex(address);
    }

    // If it's EVM-style (0x...), convert to Tron hex then base58
    if (address.startsWith('0x')) {
      const hexWithPrefix = '41' + address.substring(2);
      return this.tronWeb.address.fromHex(hexWithPrefix);
    }

    // Already in base58 format
    return address;
  }
}
