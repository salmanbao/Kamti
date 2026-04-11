import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { IEcosystemFeeCalculator } from './ecosystem-fee-calculator.interface';
import { EvmFeeCalculator } from './evm-fee-calculator';
import { SolanaFeeCalculator } from './solana-fee-calculator';
import { BitcoinFeeCalculator } from './bitcoin-fee-calculator';
import { TronFeeCalculator } from './tron-fee-calculator';

export type Ecosystem = 'evm' | 'solana' | 'bitcoin' | 'tron';

/**
 * Factory for creating ecosystem-specific fee calculators
 * Provides the appropriate calculator based on the blockchain ecosystem
 */
@Injectable()
export class EcosystemFeeCalculatorFactory {
  private readonly logger: WinstonLoggerService;
  private readonly calculators: Map<Ecosystem, IEcosystemFeeCalculator> =
    new Map();

  constructor(
    private readonly winstonLogger: WinstonLoggerService,
    private readonly evmCalculator: EvmFeeCalculator,
    private readonly solanaCalculator: SolanaFeeCalculator,
    private readonly bitcoinCalculator: BitcoinFeeCalculator,
    private readonly tronCalculator: TronFeeCalculator,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(EcosystemFeeCalculatorFactory.name);

    // Initialize the map with proper typing
    this.calculators.set('evm', evmCalculator);
    this.calculators.set('solana', solanaCalculator);
    this.calculators.set('bitcoin', bitcoinCalculator);
    this.calculators.set('tron', tronCalculator);

    this.logger.log(
      'EcosystemFeeCalculatorFactory initialized with calculators',
      {
        ecosystems: Array.from(this.calculators.keys()),
      },
    );
  }

  /**
   * Get fee calculator for specific ecosystem
   * @param ecosystem - The blockchain ecosystem type
   * @returns Fee calculator instance for the ecosystem
   */
  getCalculator(ecosystem: Ecosystem): IEcosystemFeeCalculator {
    const calculator = this.calculators.get(ecosystem);

    if (!calculator) {
      this.logger.warn(
        `No calculator found for ecosystem: ${ecosystem}, falling back to EVM`,
        {
          requestedEcosystem: ecosystem,
          availableEcosystems: Array.from(this.calculators.keys()),
        },
      );
      return this.evmCalculator; // Default fallback
    }

    return calculator;
  }

  /**
   * Detect ecosystem from chainId
   * @param chainId - Chain identifier (number or string)
   * @returns Detected ecosystem type
   */
  detectEcosystem(chainId: number | string): Ecosystem {
    const chainIdStr = String(chainId).toLowerCase();
    const chainIdNum =
      typeof chainId === 'number' ? chainId : parseInt(String(chainId), 10);

    // Solana detection
    if (
      chainIdNum === 1151111081099710 || // Rubic's Solana chainId
      chainIdNum === 7565164 || // Alternative Solana chainId
      chainIdStr.includes('solana') ||
      chainIdStr === 'sol' ||
      chainIdStr === 'solana-mainnet'
    ) {
      return 'solana';
    }

    // Tron detection
    if (
      chainIdNum === 195 ||
      chainIdStr === 'tron' ||
      chainIdStr === 'tron-mainnet' ||
      chainIdStr === 'trx'
    ) {
      return 'tron';
    }

    // Bitcoin detection
    if (
      chainIdNum === 5555 ||
      chainIdStr.includes('bitcoin') ||
      chainIdStr.includes('litecoin') ||
      chainIdStr === 'btc' ||
      chainIdStr === 'ltc'
    ) {
      return 'bitcoin';
    }

    // Default to EVM for numeric chain IDs and unknown strings
    return 'evm';
  }

  /**
   * Get Solana calculator (for setting connection)
   */
  getSolanaCalculator(): SolanaFeeCalculator {
    return this.solanaCalculator;
  }
}
