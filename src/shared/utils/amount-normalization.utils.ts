import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '../services/winston-logger.service';

/**
 * Provider types for amount formatting
 */
export enum ProviderAmountFormat {
  WEI = 'wei', // Always expects wei/smallest unit (0x, Odos, most EVM)
  DECIMAL = 'decimal', // Expects decimal string (Rubic, some meta-aggregators)
  MIXED = 'mixed', // Can handle both formats intelligently
}

/**
 * Amount normalization utility for unifying token amounts across different providers
 * Ensures each provider receives amounts in the format they expect
 */
@Injectable()
export class AmountNormalizationUtils {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(AmountNormalizationUtils.name);
  }

  /**
   * Normalize amount for a specific provider type
   *
   * @param amount - Input amount (can be wei or decimal)
   * @param decimals - Token decimals
   * @param targetFormat - Target format for the provider
   * @returns Normalized amount string
   */
  normalizeAmount(
    amount: string,
    decimals: number,
    targetFormat: ProviderAmountFormat,
  ): string {
    try {
      this.logger.debug(
        `Normalizing amount: ${amount} (decimals: ${decimals}) -> ${targetFormat}`,
      );

      // Validate input
      if (!amount || amount === '0') {
        return '0';
      }

      const isDecimalFormat = this.isDecimalFormat(amount);

      switch (targetFormat) {
        case ProviderAmountFormat.WEI:
          return this.toWei(amount, decimals);

        case ProviderAmountFormat.DECIMAL:
          return this.toDecimal(amount, decimals);

        case ProviderAmountFormat.MIXED:
          // For mixed format, prefer the input format
          return amount;

        default:
          throw new Error(`Unsupported target format: ${targetFormat}`);
      }
    } catch (error) {
      this.logger.error(`Amount normalization failed: ${error.message}`, {
        amount,
        decimals,
        targetFormat,
      });
      throw new Error(`Amount normalization failed: ${error.message}`);
    }
  }

  /**
   * Convert amount to wei format (smallest unit)
   * Works with both decimal and wei inputs
   */
  private toWei(amount: string, decimals: number): string {
    // If already in wei format (large integer without decimals)
    if (!this.isDecimalFormat(amount)) {
      return amount;
    }

    // Convert decimal to wei
    const [integerPart, decimalPart = ''] = amount.split('.');

    // Pad or truncate decimal part to match token decimals
    const normalizedDecimalPart = decimalPart
      .padEnd(decimals, '0')
      .slice(0, decimals);

    // Combine and convert to BigInt
    const fullString = integerPart + normalizedDecimalPart;
    const result = BigInt(fullString || '0').toString();

    this.logger.debug(`Converted to wei: ${amount} -> ${result}`);
    return result;
  }

  /**
   * Convert amount to decimal format
   * Works with both wei and decimal inputs
   */
  private toDecimal(amount: string, decimals: number): string {
    // If already in decimal format
    if (this.isDecimalFormat(amount)) {
      return amount;
    }

    // Convert wei to decimal
    const num = BigInt(amount);
    // Use BigInt exponentiation to avoid precision issues with large decimals
    const divisor = BigInt(10) ** BigInt(decimals);
    const integerPart = num / divisor;
    const remainder = num % divisor;

    if (remainder === BigInt(0)) {
      const result = integerPart.toString();
      this.logger.debug(`Converted to decimal: ${amount} -> ${result}`);
      return result;
    }

    // Format with decimals, removing trailing zeros
    const decimalPart = remainder.toString().padStart(decimals, '0');
    const trimmedDecimal = decimalPart.replace(/0+$/, '');
    const result = trimmedDecimal
      ? `${integerPart}.${trimmedDecimal}`
      : integerPart.toString();

    this.logger.debug(`Converted to decimal: ${amount} -> ${result}`);
    return result;
  }

  /**
   * Determine if amount is in decimal format
   * Heuristics:
   * - Contains decimal point
   * - Is a small number (< 1000, likely not wei)
   * - Has scientific notation
   */
  private isDecimalFormat(amount: string): boolean {
    // Contains decimal point
    if (amount.includes('.')) {
      return true;
    }

    // Contains scientific notation
    if (amount.toLowerCase().includes('e')) {
      return true;
    }

    // Small numbers are likely decimal (not wei)
    const numValue = parseFloat(amount);
    if (!isNaN(numValue) && numValue < 1000 && numValue > 0) {
      return true;
    }

    return false;
  }

  /**
   * Get the expected amount format for a specific provider
   */
  getProviderAmountFormat(providerName: string): ProviderAmountFormat {
    const provider = providerName.toLowerCase();

    switch (provider) {
      case '0x':
      case 'odos':
      case 'zerox':
        return ProviderAmountFormat.WEI;

      case 'rubic':
      case 'socket':
      case 'rango':
        return ProviderAmountFormat.DECIMAL;

      case 'thorchain':
      case 'maya':
        return ProviderAmountFormat.WEI; // Native L1 uses smallest units

      default:
        this.logger.warn(
          `Unknown provider ${providerName}, defaulting to WEI format`,
        );
        return ProviderAmountFormat.WEI;
    }
  }

  /**
   * Validate amount format and provide helpful error messages
   */
  validateAmount(amount: string, context: string = ''): void {
    if (!amount) {
      throw new Error(
        `Amount cannot be empty${context ? ` in ${context}` : ''}`,
      );
    }

    if (amount === '0') {
      throw new Error(
        `Amount cannot be zero${context ? ` in ${context}` : ''}`,
      );
    }

    // Check for negative amounts
    if (amount.startsWith('-')) {
      throw new Error(
        `Amount cannot be negative${context ? ` in ${context}` : ''}`,
      );
    }

    // Check for invalid characters
    const validPattern = /^[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?$/;
    if (!validPattern.test(amount)) {
      throw new Error(
        `Invalid amount format: ${amount}${context ? ` in ${context}` : ''}`,
      );
    }

    // Check for reasonable bounds
    const numValue = parseFloat(amount);
    if (isNaN(numValue) || numValue <= 0) {
      throw new Error(
        `Amount must be a positive number${context ? ` in ${context}` : ''}`,
      );
    }

    // Check for extremely large numbers that might cause overflow
    if (numValue > Number.MAX_SAFE_INTEGER) {
      // This is likely in wei format, which is fine
      try {
        BigInt(amount.split('.')[0]); // Test if the integer part can be converted to BigInt
      } catch {
        throw new Error(
          `Amount is too large to process${context ? ` in ${context}` : ''}`,
        );
      }
    }
  }

  /**
   * Normalize amount for specific provider by name
   * Convenience method that combines provider detection and normalization
   */
  normalizeForProvider(
    amount: string,
    decimals: number,
    providerName: string,
    context: string = '',
  ): string {
    this.validateAmount(amount, context);

    const targetFormat = this.getProviderAmountFormat(providerName);
    const normalizedAmount = this.normalizeAmount(
      amount,
      decimals,
      targetFormat,
    );

    this.logger.debug(
      `Normalized for ${providerName}: ${amount} -> ${normalizedAmount} (${targetFormat})`,
    );
    return normalizedAmount;
  }
}
