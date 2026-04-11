import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { IEcosystemFeeCalculator } from './ecosystem-fee-calculator.interface';

/**
 * Solana Fee Calculator
 * Handles fee calculation for Solana blockchain
 * Accounts for: signature fees, compute budget, rent-exempt minimum, and safety buffer
 */
@Injectable()
export class SolanaFeeCalculator implements IEcosystemFeeCalculator {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(SolanaFeeCalculator.name);
  }
  private connection: Connection | null = null;

  /**
   * Set Solana RPC connection (called by wallet provider)
   */
  setConnection(connection: Connection): void {
    this.connection = connection;
  }

  /**
   * Solana full-balance calculation
   * Reserves: signature fee + compute budget + rent-exempt minimum + safety buffer
   */
  async calculateFullBalanceAdjustment(
    balance: string,
    isFullBalance: boolean,
    additionalParams?: {
      walletPublicKey?: string;
      computeUnits?: number;
      priorityFeeMicroLamports?: number;
    },
  ): Promise<{
    adjustedAmount: string;
    reserved: string;
    breakdown: {
      transactionFee: string;
      rentReserve: string;
      safetyBuffer: string;
      other: {
        signatureFee: string;
        computeBudgetFee: string;
      };
    };
  }> {
    if (!isFullBalance || balance === '0') {
      // Not a full-balance swap, return original balance
      return {
        adjustedAmount: balance,
        reserved: '0',
        breakdown: {
          transactionFee: '0',
          rentReserve: '0',
          safetyBuffer: '0',
          other: {
            signatureFee: '0',
            computeBudgetFee: '0',
          },
        },
      };
    }

    const balanceLamports = BigInt(balance);

    // 1. Signature fee (fixed per transaction)
    const SIGNATURE_FEE = BigInt(5000);

    // 2. Compute budget fee (dynamic based on priority)
    const computeUnits = additionalParams?.computeUnits || 400000; // Default: 400k CU
    const priorityFeeMicroLamports =
      additionalParams?.priorityFeeMicroLamports || 1000; // Default: 1000 micro-lamports per CU
    const computeBudgetFee = BigInt(
      Math.ceil((computeUnits * priorityFeeMicroLamports) / 1_000_000),
    );

    // 3. Rent-exempt minimum (query from network or use conservative estimate)
    let rentReserve = BigInt(890880); // Default: ~0.00089088 SOL for 165-byte account
    if (this.connection) {
      try {
        const minBalance =
          await this.connection.getMinimumBalanceForRentExemption(165);
        rentReserve = BigInt(minBalance);
      } catch (error) {
        this.logger.warn('Failed to query rent-exempt minimum, using default', {
          error: error.message,
          default: rentReserve.toString(),
        });
      }
    } else {
      this.logger.warn(
        'No Solana connection available, using default rent reserve',
        {
          default: rentReserve.toString(),
        },
      );
    }

    // 4. Total transaction fee (signature + compute budget)
    const transactionFee = SIGNATURE_FEE + computeBudgetFee;

    // 5. Safety buffer (5% of total fees or minimum 50,000 lamports)
    const totalFees = transactionFee + rentReserve;
    const safetyBuffer =
      totalFees > BigInt(1000000)
        ? (totalFees * BigInt(5)) / BigInt(100) // 5%
        : BigInt(50000); // Minimum 50,000 lamports

    // 6. Total amount to reserve
    const totalReserved = transactionFee + rentReserve + safetyBuffer;

    // 7. Adjusted amount (what we can actually send)
    const adjustedAmount = balanceLamports - totalReserved;

    if (adjustedAmount <= 0n) {
      this.logger.warn(
        'Solana balance adjustment would result in zero or negative amount',
        {
          balance,
          signatureFee: SIGNATURE_FEE.toString(),
          computeBudgetFee: computeBudgetFee.toString(),
          rentReserve: rentReserve.toString(),
          safetyBuffer: safetyBuffer.toString(),
          totalReserved: totalReserved.toString(),
        },
      );
      throw new Error(
        'Insufficient balance for Solana transaction fees and rent reserve',
      );
    }

    this.logger.debug('Solana full-balance adjustment calculated', {
      balance,
      adjustedAmount: adjustedAmount.toString(),
      totalReserved: totalReserved.toString(),
      breakdown: {
        signatureFee: SIGNATURE_FEE.toString(),
        computeBudgetFee: computeBudgetFee.toString(),
        rentReserve: rentReserve.toString(),
        safetyBuffer: safetyBuffer.toString(),
      },
    });

    return {
      adjustedAmount: adjustedAmount.toString(),
      reserved: totalReserved.toString(),
      breakdown: {
        transactionFee: transactionFee.toString(),
        rentReserve: rentReserve.toString(),
        safetyBuffer: safetyBuffer.toString(),
        other: {
          signatureFee: SIGNATURE_FEE.toString(),
          computeBudgetFee: computeBudgetFee.toString(),
        },
      },
    };
  }

  /**
   * Estimate Solana transaction cost
   * For Solana, gas cost is typically 0 for balance checks (fees are separate)
   */
  async estimateTransactionCost(txParams: any): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    // Solana doesn't use gas in the same way as EVM
    // For amount adjustment purposes, we return 0 gas cost
    // The actual fees are calculated in calculateFullBalanceAdjustment
    return {
      gasLimit: '0',
      gasCost: '0',
    };
  }

  /**
   * Get minimum buffer for Solana (Rubic rounding buffer)
   */
  getMinimumBuffer(): string {
    return '100'; // 100 lamports for Rubic API rounding
  }
}
