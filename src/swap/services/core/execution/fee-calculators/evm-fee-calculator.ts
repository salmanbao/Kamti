import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { IEcosystemFeeCalculator } from './ecosystem-fee-calculator.interface';

/**
 * EVM (Ethereum Virtual Machine) Fee Calculator
 * Handles fee calculation for EVM-compatible chains (Ethereum, BSC, Polygon, etc.)
 */
@Injectable()
export class EvmFeeCalculator implements IEcosystemFeeCalculator {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(EvmFeeCalculator.name);
  }

  /**
   * EVM full-balance calculation
   * For EVM chains, we need to reserve: gasLimit * gasPrice + small buffer
   */
  async calculateFullBalanceAdjustment(
    balance: string,
    isFullBalance: boolean,
    additionalParams?: {
      gasLimit?: string;
      gasPrice?: string;
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
    },
  ): Promise<{
    adjustedAmount: string;
    reserved: string;
    breakdown: {
      transactionFee: string;
      safetyBuffer: string;
    };
  }> {
    if (!isFullBalance) {
      // Not a full-balance swap, return original balance
      return {
        adjustedAmount: balance,
        reserved: '0',
        breakdown: {
          transactionFee: '0',
          safetyBuffer: '0',
        },
      };
    }

    const balanceBigInt = BigInt(balance);

    // Calculate transaction fee (gasLimit * gasPrice or maxFeePerGas)
    const gasLimit = BigInt(additionalParams?.gasLimit || '21000'); // Default: simple transfer
    const gasPrice = BigInt(
      additionalParams?.maxFeePerGas ||
        additionalParams?.gasPrice ||
        '1000000000', // 1 gwei default
    );
    const transactionFee = gasLimit * gasPrice;

    // Safety buffer: 10% of transaction fee or minimum 50,000 wei
    // Provides reasonable cushion for gas price fluctuations
    // without excessively restricting swap amounts
    const safetyBuffer =
      transactionFee > BigInt(100000)
        ? (transactionFee * BigInt(10)) / BigInt(100) // 10%
        : BigInt(50000); // Minimum 50,000 wei

    const totalReserved = transactionFee + safetyBuffer;
    const adjustedAmount = balanceBigInt - totalReserved;

    if (adjustedAmount <= 0n) {
      this.logger.warn(
        'EVM balance adjustment would result in zero or negative amount',
        {
          balance,
          transactionFee: transactionFee.toString(),
          safetyBuffer: safetyBuffer.toString(),
        },
      );
      throw new Error('Insufficient balance for EVM transaction fees');
    }

    return {
      adjustedAmount: adjustedAmount.toString(),
      reserved: totalReserved.toString(),
      breakdown: {
        transactionFee: transactionFee.toString(),
        safetyBuffer: safetyBuffer.toString(),
      },
    };
  }

  /**
   * Estimate gas cost for EVM transaction
   */
  async estimateTransactionCost(txParams: any): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    // This is typically handled by the executor using walletService.estimateGas()
    // For base implementation, return conservative defaults
    const gasLimit = txParams.gasLimit || '21000';
    const gasPrice = txParams.gasPrice || '1000000000'; // 1 gwei
    const gasCost = (BigInt(gasLimit) * BigInt(gasPrice)).toString();

    return { gasLimit, gasCost };
  }

  /**
   * Get minimum buffer for EVM (Rubic rounding buffer)
   */
  getMinimumBuffer(): string {
    return '100'; // 100 wei for Rubic API rounding
  }
}
