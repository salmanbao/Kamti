import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';

/**
 * Price Impact Validation Result
 */
export interface PriceImpactValidationResult {
  isValid: boolean;
  priceImpactPercent: number | null;
  threshold: number;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  warning?: string;
  shouldBlock: boolean;
}

/**
 * Price Impact Thresholds Configuration
 */
export interface PriceImpactThresholds {
  warning: number; // Warn user but allow (default: 1%)
  high: number; // High impact warning (default: 3%)
  critical: number; // Block execution (default: 5%)
  enabled: boolean; // Whether validation is enabled
}

/**
 * Price Impact Validator Service
 * 
 * Validates price impact for swaps and provides configurable thresholds
 * to protect users from high slippage transactions.
 * 
 * Features:
 * - Configurable thresholds (warning, high, critical)
 * - Severity classification (low, medium, high, critical)
 * - Optional blocking for critical price impacts
 * - Environment-based configuration
 * - Detailed logging for monitoring
 * 
 * Usage:
 * ```typescript
 * const validation = await priceImpactValidator.validate(quote);
 * if (!validation.isValid) {
 *   throw new Error(validation.warning);
 * }
 * ```
 */
@Injectable()
export class PriceImpactValidatorService {
  private readonly thresholds: PriceImpactThresholds;

  constructor(
    private readonly logger: WinstonLoggerService,
    private readonly envConfig: EnvironmentConfigService,
  ) {
    this.logger.setContext(PriceImpactValidatorService.name);
    
    // Load thresholds from environment or use defaults
    this.thresholds = {
      warning: this.envConfig.priceImpactWarningThreshold,
      high: this.envConfig.priceImpactHighThreshold,
      critical: this.envConfig.priceImpactCriticalThreshold,
      enabled: this.envConfig.priceImpactValidationEnabled,
    };

    this.logger.log(
      `Price impact validation initialized: ${JSON.stringify(this.thresholds)}`,
    );
  }

  /**
   * Validate price impact for a quote
   * 
   * @param priceImpact - Price impact as string (e.g., "2.5") or number
   * @param context - Optional context for logging (e.g., aggregator name)
   * @returns Validation result with severity and recommendations
   */
  validate(
    priceImpact: string | number | undefined | null,
    context?: string,
  ): PriceImpactValidationResult {
    // If validation is disabled, pass all quotes
    if (!this.thresholds.enabled) {
      return {
        isValid: true,
        priceImpactPercent: null,
        threshold: 0,
        severity: 'none',
        shouldBlock: false,
      };
    }

    // If price impact is not provided, log warning and allow
    if (priceImpact === undefined || priceImpact === null) {
      this.logger.debug(
        `Price impact not provided${context ? ` for ${context}` : ''}, skipping validation`,
      );
      return {
        isValid: true,
        priceImpactPercent: null,
        threshold: 0,
        severity: 'none',
        shouldBlock: false,
      };
    }

    // Parse price impact to number
    const priceImpactPercent = this.parsePriceImpact(priceImpact);

    // Handle invalid price impact values
    if (priceImpactPercent === null || isNaN(priceImpactPercent)) {
      this.logger.warn(
        `Invalid price impact value: ${priceImpact}${context ? ` for ${context}` : ''}`,
      );
      return {
        isValid: true, // Allow if parsing fails (defensive)
        priceImpactPercent: null,
        threshold: 0,
        severity: 'none',
        shouldBlock: false,
        warning: 'Unable to parse price impact value',
      };
    }

    // Determine severity and validation result
    const result = this.classifyPriceImpact(priceImpactPercent);

    // Log based on severity
    if (result.severity === 'critical' || result.severity === 'high') {
      this.logger.warn(
        `${result.severity.toUpperCase()} price impact detected: ${priceImpactPercent.toFixed(2)}%${context ? ` for ${context}` : ''}`,
      );
    } else if (result.severity === 'medium') {
      this.logger.debug(
        `Moderate price impact: ${priceImpactPercent.toFixed(2)}%${context ? ` for ${context}` : ''}`,
      );
    }

    return result;
  }

  /**
   * Validate multiple quotes and return the best valid option
   * 
   * @param quotes - Array of quotes with price impacts
   * @param extractPriceImpact - Function to extract price impact from quote
   * @returns Best valid quote or null if all are invalid
   */
  validateAndFilterQuotes<T>(
    quotes: T[],
    extractPriceImpact: (quote: T) => string | number | undefined | null,
  ): { validQuotes: T[]; invalidQuotes: Array<{ quote: T; reason: string }> } {
    const validQuotes: T[] = [];
    const invalidQuotes: Array<{ quote: T; reason: string }> = [];

    for (const quote of quotes) {
      const priceImpact = extractPriceImpact(quote);
      const validation = this.validate(priceImpact);

      if (validation.shouldBlock) {
        invalidQuotes.push({
          quote,
          reason: validation.warning || 'Price impact exceeds critical threshold',
        });
      } else {
        validQuotes.push(quote);
      }
    }

    return { validQuotes, invalidQuotes };
  }

  /**
   * Get current threshold configuration
   */
  getThresholds(): PriceImpactThresholds {
    return { ...this.thresholds };
  }

  /**
   * Update thresholds dynamically (for testing or runtime adjustment)
   * Note: Changes are not persisted to environment variables
   */
  updateThresholds(thresholds: Partial<PriceImpactThresholds>): void {
    Object.assign(this.thresholds, thresholds);
    this.logger.log(
      `Price impact thresholds updated: ${JSON.stringify(this.thresholds)}`,
    );
  }

  /**
   * Parse price impact from various formats
   * 
   * Supports:
   * - String: "2.5", "0.025" (both interpreted as 2.5%)
   * - Number: 2.5, 0.025
   * - Handles both percentage (2.5) and decimal (0.025) formats
   * 
   * @private
   */
  private parsePriceImpact(
    priceImpact: string | number,
  ): number | null {
    try {
      let value: number;

      if (typeof priceImpact === 'string') {
        // Remove any percentage signs and whitespace
        const cleaned = priceImpact.replace(/[%\s]/g, '');
        value = parseFloat(cleaned);
      } else {
        value = priceImpact;
      }

      // If value is less than 1, assume it's in decimal format (0.025 = 2.5%)
      // Otherwise, assume it's already in percentage format (2.5 = 2.5%)
      if (value < 1 && value > 0) {
        value = value * 100;
      }

      return value;
    } catch (error) {
      this.logger.error(
        `Failed to parse price impact: ${priceImpact}`,
        error,
      );
      return null;
    }
  }

  /**
   * Classify price impact and determine validation result
   * 
   * @private
   */
  private classifyPriceImpact(
    priceImpactPercent: number,
  ): PriceImpactValidationResult {
    // Critical: Block execution
    if (priceImpactPercent >= this.thresholds.critical) {
      return {
        isValid: false,
        priceImpactPercent,
        threshold: this.thresholds.critical,
        severity: 'critical',
        shouldBlock: true,
        warning: `Price impact of ${priceImpactPercent.toFixed(2)}% exceeds critical threshold of ${this.thresholds.critical}%. Transaction blocked to protect user.`,
      };
    }

    // High: Strong warning but allow
    if (priceImpactPercent >= this.thresholds.high) {
      return {
        isValid: true,
        priceImpactPercent,
        threshold: this.thresholds.high,
        severity: 'high',
        shouldBlock: false,
        warning: `High price impact detected: ${priceImpactPercent.toFixed(2)}%. Consider using a different route or reducing trade size.`,
      };
    }

    // Medium: Warning level
    if (priceImpactPercent >= this.thresholds.warning) {
      return {
        isValid: true,
        priceImpactPercent,
        threshold: this.thresholds.warning,
        severity: 'medium',
        shouldBlock: false,
        warning: `Moderate price impact: ${priceImpactPercent.toFixed(2)}%. Please review before proceeding.`,
      };
    }

    // Low: Acceptable price impact
    if (priceImpactPercent > 0.1) {
      return {
        isValid: true,
        priceImpactPercent,
        threshold: this.thresholds.warning,
        severity: 'low',
        shouldBlock: false,
      };
    }

    // Negligible
    return {
      isValid: true,
      priceImpactPercent,
      threshold: this.thresholds.warning,
      severity: 'none',
      shouldBlock: false,
    };
  }
}
