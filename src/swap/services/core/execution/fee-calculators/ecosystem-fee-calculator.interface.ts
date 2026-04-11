/**
 * Ecosystem-specific fee calculator interface
 * Each blockchain ecosystem has different fee structures and requirements
 */
export interface IEcosystemFeeCalculator {
  /**
   * Calculate the total fees and reserves needed for a full-balance swap
   *
   * @param balance - Current wallet balance in smallest units (wei, lamports, satoshi, etc.)
   * @param isFullBalance - Whether this is a full-balance swap
   * @param additionalParams - Ecosystem-specific parameters (gasPrice, computeUnits, etc.)
   * @returns Object containing adjusted amount and total reserves
   */
  calculateFullBalanceAdjustment(
    balance: string,
    isFullBalance: boolean,
    additionalParams?: Record<string, any>,
  ): Promise<{
    adjustedAmount: string;
    reserved: string;
    breakdown: {
      transactionFee: string;
      rentReserve?: string;
      safetyBuffer: string;
      other?: Record<string, string>;
    };
  }>;

  /**
   * Calculate gas/fee estimate for a transaction
   * Used during amount adjustment to determine how much to reserve
   *
   * @param txParams - Transaction parameters
   * @returns Gas estimate with cost and limit
   */
  estimateTransactionCost(txParams: any): Promise<{
    gasLimit: string;
    gasCost: string;
  }>;

  /**
   * Get the minimum buffer needed for this ecosystem
   * This is used for non-full-balance swaps (e.g., Rubic rounding buffer)
   *
   * @returns Buffer amount in smallest units
   */
  getMinimumBuffer(): string;
}
