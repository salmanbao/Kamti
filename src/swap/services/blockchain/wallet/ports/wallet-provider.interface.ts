import { BalanceInfo, TokenInfo } from '@swap/models/swap-request.model';
import { TransactionReceipt } from 'viem';

/**
 * Interface for blockchain-specific wallet providers
 * Each blockchain ecosystem implements this interface
 */
export interface IWalletProvider {
  /**
   * Get the ecosystem this provider supports
   */
  getEcosystem(): string;

  /**
   * Check if this provider supports a specific chain
   */
  supportsChain(chainId: number | string): boolean;

  /**
   * Get wallet balance for a token
   */
  getBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress?: string,
  ): Promise<BalanceInfo>;

  /**
   * Get multiple token balances
   */
  getMultipleBalances(
    chainId: number | string,
    walletAddress: string,
    tokenAddresses: string[],
  ): Promise<BalanceInfo[]>;

  /**
   * Get token information
   */
  getTokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo>;

  /**
   * Check token allowance (if applicable for this chain)
   */
  getAllowance?(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string>;

  /**
   * Execute approval transaction (if applicable for this chain)
   */
  executeApproval?(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    spender: string,
    amount: string,
  ): Promise<string>;

  /**
   * Execute transaction
   */
  executeTransaction(
    chainId: number | string,
    privateKey: string,
    to: string,
    data: string,
    value: string,
    gasLimit?: string,
    providedGasPrices?: {
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
      gasPrice?: string;
    },
  ): Promise<string>;

  /**
   * Estimate gas for a transaction (if applicable for this chain)
   */
  estimateGas?(
    chainId: number | string,
    from: string,
    to: string,
    data: string,
    value?: string,
  ): Promise<string>;

  /**
   * Estimate fee data for a transaction
   * Should return EIP-1559 fields when supported, otherwise legacy gasPrice
   */
  estimateFees?(
    chainId: number | string,
  ): Promise<
    | { type: 'eip1559'; maxFeePerGas: string; maxPriorityFeePerGas: string }
    | { type: 'legacy'; gasPrice: string }
  >;

  /**
   * Wait for transaction confirmation
   */
  waitForTransactionConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations?: number,
  ): Promise<any>;

  /**
   * Get transaction status
   */
  getTransactionStatus(
    chainId: number | string,
    txHash: string,
  ): Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    receipt?: any;
  }>;

  /**
   * Parse transaction receipt to extract token transfers (if applicable for this chain)
   * Optional method - primarily for EVM chains
   */
  parseTransactionReceipt?(
    receipt: any,
    tokenAddress: string,
  ): Array<{ from: string; to: string; amount: bigint }>;
}

/**
 * Wallet provider configuration
 */
export interface WalletProviderConfig {
  name: string;
  ecosystem: string;
  enabled: boolean;
  supportedChains: number[] | string[];
}
