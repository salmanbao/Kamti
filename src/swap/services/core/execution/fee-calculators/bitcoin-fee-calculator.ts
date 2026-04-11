import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { IEcosystemFeeCalculator } from './ecosystem-fee-calculator.interface';

/**
 * Bitcoin Fee Calculator
 * Handles fee calculation for Bitcoin and similar UTXO-based chains
 */
@Injectable()
export class BitcoinFeeCalculator implements IEcosystemFeeCalculator {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(BitcoinFeeCalculator.name);
  }

  /**
   * Bitcoin full-balance calculation
   * For Bitcoin, fees depend on transaction size and sat/vByte rate
   */
  async calculateFullBalanceAdjustment(
    balance: string,
    isFullBalance: boolean,
    additionalParams?: {
      feeRate?: string; // satoshis per vByte
      inputCount?: number;
      outputCount?: number;
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
      return {
        adjustedAmount: balance,
        reserved: '0',
        breakdown: {
          transactionFee: '0',
          safetyBuffer: '0',
        },
      };
    }

    const balanceSatoshis = BigInt(balance);

    // Estimate transaction size in vBytes
    // Typical: 1 input = ~148 vBytes, 1 output = ~34 vBytes, overhead = ~10 vBytes
    const inputCount = additionalParams?.inputCount || 1;
    const outputCount = additionalParams?.outputCount || 2; // 1 recipient + 1 change
    const txSizeVBytes = inputCount * 148 + outputCount * 34 + 10;

    // Fee rate (satoshis per vByte)
    const feeRate = BigInt(additionalParams?.feeRate || '20'); // Default: 20 sat/vByte
    const transactionFee = BigInt(txSizeVBytes) * feeRate;

    // Safety buffer: 10% of transaction fee or minimum 1000 satoshis
    const safetyBuffer =
      transactionFee > BigInt(10000)
        ? (transactionFee * BigInt(10)) / BigInt(100) // 10%
        : BigInt(1000); // Minimum 1000 satoshis

    const totalReserved = transactionFee + safetyBuffer;
    const adjustedAmount = balanceSatoshis - totalReserved;

    if (adjustedAmount <= 0n) {
      this.logger.warn(
        'Bitcoin balance adjustment would result in zero or negative amount',
        {
          balance,
          transactionFee: transactionFee.toString(),
          safetyBuffer: safetyBuffer.toString(),
        },
      );
      throw new Error('Insufficient balance for Bitcoin transaction fees');
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

  async estimateTransactionCost(txParams: any): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    // Bitcoin doesn't use gas, return 0
    return {
      gasLimit: '0',
      gasCost: '0',
    };
  }

  getMinimumBuffer(): string {
    return '100'; // 100 satoshis
  }
}
