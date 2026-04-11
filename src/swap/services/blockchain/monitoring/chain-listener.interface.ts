/**
 * Chain Listener Interface
 *
 * Defines the contract for blockchain-specific transaction monitoring services.
 * Each blockchain ecosystem (EVM, Solana, Bitcoin) implements this interface
 * to provide unified transaction confirmation tracking.
 */

export interface TransactionStatus {
  txHash: string;
  status: 'pending' | 'confirmed' | 'finalized' | 'failed';
  confirmations: number;
  blockNumber?: number;
  blockHash?: string;
  timestamp?: string;
  error?: string;
}

export interface BalanceChangeEvent {
  address: string;
  token?: string; // Token address, undefined for native
  previousBalance: string;
  newBalance: string;
  change: string; // Positive or negative change
  txHash?: string;
  blockNumber?: number;
}

export interface TransactionReceipt {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  status: 'success' | 'failed';
  gasUsed?: string;
  effectiveGasPrice?: string;
  from: string;
  to: string;
  value?: string;
  logs?: any[];
  timestamp: string;
}

export interface ConfirmationEvent {
  txHash: string;
  confirmations: number;
  blockNumber: number;
  blockHash: string;
  timestamp: string;
  isFinalized: boolean;
}

/**
 * Chain Listener Interface
 *
 * Requirement #4: WebSocket mechanism to listen for transactions on receiver address
 * Requirement #5: Wait for minimum confirmations in round-trip swaps
 * Requirement #6: Record received amount after swap confirmation
 */
export interface IChainListener {
  /**
   * Get blockchain ecosystem type
   */
  getEcosystem(): string;

  /**
   * Get chain ID
   */
  getChainId(): number | string;

  /**
   * Start listening for transactions on an address
   *
   * @param address - Address to monitor
   * @param callback - Callback function for transaction events
   * @returns Subscription ID for cleanup
   */
  watchAddress(
    address: string,
    callback: (event: BalanceChangeEvent) => void,
  ): Promise<string>;

  /**
   * Stop listening for transactions on an address
   *
   * @param subscriptionId - Subscription ID from watchAddress
   */
  unwatchAddress(subscriptionId: string): Promise<void>;

  /**
   * Wait for transaction confirmation
   *
   * @param txHash - Transaction hash
   * @param minConfirmations - Minimum confirmations to wait for (requirement #5)
   * @param callback - Optional callback for each confirmation
   * @returns Promise resolving when confirmations reached
   */
  waitForConfirmations(
    txHash: string,
    minConfirmations: number,
    callback?: (event: ConfirmationEvent) => void,
  ): Promise<TransactionReceipt>;

  /**
   * Get current transaction status
   *
   * @param txHash - Transaction hash
   * @returns Current transaction status
   */
  getTransactionStatus(txHash: string): Promise<TransactionStatus>;

  /**
   * Get transaction receipt with full details
   *
   * @param txHash - Transaction hash
   * @returns Transaction receipt or null if not found
   */
  getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null>;

  /**
   * Get actual received amount from transaction (requirement #6)
   *
   * Parses transaction receipt/logs to determine actual amount received by recipient.
   * Critical for round-trip swaps where actual amount (not estimate) must be used.
   *
   * @param txHash - Transaction hash
   * @param recipientAddress - Recipient address
   * @param tokenAddress - Token address (undefined for native token)
   * @returns Actual amount received in smallest unit
   */
  getActualReceivedAmount(
    txHash: string,
    recipientAddress: string,
    tokenAddress?: string,
  ): Promise<{
    amount: string;
    token: string;
    recipient: string;
    blockNumber: number;
    timestamp: string;
  }>;

  /**
   * Get current block number
   */
  getCurrentBlockNumber(): Promise<number>;

  /**
   * Estimate time to reach N confirmations
   *
   * @param confirmations - Number of confirmations
   * @returns Estimated time in seconds
   */
  estimateConfirmationTime(confirmations: number): number;

  /**
   * Check if chain listener is healthy
   */
  isHealthy(): Promise<boolean>;
}
