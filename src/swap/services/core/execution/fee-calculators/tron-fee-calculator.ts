import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { IEcosystemFeeCalculator } from './ecosystem-fee-calculator.interface';

/**
 * Tron (TVM) Fee Calculator
 * Handles fee calculation for Tron blockchain
 */
@Injectable()
export class TronFeeCalculator implements IEcosystemFeeCalculator {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(TronFeeCalculator.name);
  }

  /**
   * Tron full-balance calculation
   * Tron uses energy and bandwidth instead of gas
   */
  async calculateFullBalanceAdjustment(
    balance: string,
    isFullBalance: boolean,
    additionalParams?: {
      energyCost?: string;
      bandwidthCost?: string;
    },
  ): Promise<{
    adjustedAmount: string;
    reserved: string;
    breakdown: {
      transactionFee: string;
      safetyBuffer: string;
      other: {
        energyCost: string;
        bandwidthCost: string;
      };
    };
  }> {
    if (!isFullBalance) {
      return {
        adjustedAmount: balance,
        reserved: '0',
        breakdown: {
          transactionFee: '0',
          safetyBuffer: '0',
          other: {
            energyCost: '0',
            bandwidthCost: '0',
          },
        },
      };
    }

    const balanceSun = BigInt(balance);

    // Tron transaction costs (in SUN, 1 TRX = 1,000,000 SUN)
    //
    // TRON FEE SYSTEM (different from EVM chains):
    // 1. BANDWIDTH: Consumed for ALL transactions based on size (bytes)
    //    - Cost: 1,000 SUN per byte when free bandwidth depleted
    //    - Typical TRX transfer: 250-350 bytes = 250,000-350,000 SUN
    //
    // 2. ENERGY: Only consumed for smart contract execution (TRC20, bridges, etc.)
    //    - Cost: 420 SUN per unit (fluctuates based on network)
    //    - Bridge contracts: 10,000-65,000 units = 4.2-27.3 TRX
    //
    // RESERVE STRATEGY:
    // - Simple TRX transfers (CEX deposits): 1.1 TRX (1,100,000 SUN)
    //   * Covers bandwidth (250-350k) + safety buffer (750-850k)
    // - Bridge contract calls (cross-chain swaps): 5 TRX (5,000,000 SUN)
    //   * Covers bandwidth + energy for smart contracts
    //
    // Default to 1.1 TRX for simple transfers (most common case for full balance swaps)
    // If energyCost is provided and high, it indicates a bridge contract call

    const providedEnergyCost = additionalParams?.energyCost
      ? BigInt(additionalParams.energyCost)
      : BigInt(0);
    const providedBandwidthCost = additionalParams?.bandwidthCost
      ? BigInt(additionalParams.bandwidthCost)
      : BigInt(0);

    // If explicit costs provided and they're high, use them (bridge contract scenario)
    // Otherwise use 1.1 TRX default (simple transfer scenario)
    let totalReserved: bigint;
    let energyCost: bigint;
    let bandwidthCost: bigint;
    let safetyBuffer: bigint;

    if (
      providedEnergyCost > BigInt(100000) ||
      providedBandwidthCost > BigInt(100000)
    ) {
      // High costs provided = bridge contract call
      energyCost = providedEnergyCost;
      bandwidthCost = providedBandwidthCost;
      const transactionFee = energyCost + bandwidthCost;
      safetyBuffer = (transactionFee * BigInt(10)) / BigInt(100); // 10% safety buffer
      totalReserved = transactionFee + safetyBuffer;

      this.logger.log('Tron bridge contract detected, using provided costs', {
        energyCost: energyCost.toString(),
        bandwidthCost: bandwidthCost.toString(),
        safetyBuffer: safetyBuffer.toString(),
        totalReserved: totalReserved.toString(),
      });
    } else {
      // Default to 1.1 TRX for simple transfers
      // Breakdown: ~350k bandwidth + 750k safety buffer = 1.1M SUN
      energyCost = BigInt(0); // Simple transfers don't use energy
      bandwidthCost = BigInt(350000); // ~350k SUN for bandwidth
      safetyBuffer = BigInt(750000); // ~750k SUN safety buffer (covers variability)
      totalReserved = BigInt(1100000); // 1.1 TRX total

      this.logger.log('Tron simple transfer assumed, using 1.1 TRX reserve', {
        bandwidthCost: bandwidthCost.toString(),
        safetyBuffer: safetyBuffer.toString(),
        totalReserved: totalReserved.toString(),
        note: 'Default reserve for simple TRX transfers',
      });
    }
    const adjustedAmount = balanceSun - totalReserved;

    if (adjustedAmount <= 0n) {
      this.logger.warn(
        'Tron balance adjustment would result in zero or negative amount',
        {
          balance,
          totalReserved: totalReserved.toString(),
          energyCost: energyCost.toString(),
          bandwidthCost: bandwidthCost.toString(),
          safetyBuffer: safetyBuffer.toString(),
        },
      );
      throw new Error('Insufficient balance for Tron transaction fees');
    }

    return {
      adjustedAmount: adjustedAmount.toString(),
      reserved: totalReserved.toString(),
      breakdown: {
        transactionFee: (energyCost + bandwidthCost).toString(),
        safetyBuffer: safetyBuffer.toString(),
        other: {
          energyCost: energyCost.toString(),
          bandwidthCost: bandwidthCost.toString(),
        },
      },
    };
  }

  async estimateTransactionCost(txParams: any): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    // Tron doesn't use gas in the traditional sense
    return {
      gasLimit: '0',
      gasCost: '0',
    };
  }

  getMinimumBuffer(): string {
    return '1100000'; // 1.1 TRX (1,100,000 SUN) - minimum reserve for Tron transactions
  }
}
