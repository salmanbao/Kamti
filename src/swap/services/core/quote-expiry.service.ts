import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { AggregatorType } from '../../models/swap-request.model';

/**
 * Quote expiry configuration per aggregator
 */
export interface QuoteExpiryConfig {
  aggregator: AggregatorType;
  expirySeconds: number;
  warningThresholdSeconds: number;
}

/**
 * Quote expiry status
 */
export interface QuoteExpiryStatus {
  isExpired: boolean;
  isNearExpiry: boolean;
  ageSeconds: number;
  remainingSeconds: number;
  expiryTimestamp: number;
  warning?: string;
  aggregator: string;
}

/**
 * Quote expiry warning system
 * Monitors quote age and provides warnings for stale quotes
 */
@Injectable()
export class QuoteExpiryService {
  constructor(private readonly logger: WinstonLoggerService) {
    this.logger.setContext(QuoteExpiryService.name);
  }

  /**
   * Default expiry configurations per aggregator
   */
  private readonly expiryConfigs: Map<AggregatorType, QuoteExpiryConfig> =
    new Map([
      // EVM aggregators
      [
        AggregatorType.ZEROX,
        {
          aggregator: AggregatorType.ZEROX,
          expirySeconds: 60, // 60 seconds validity
          warningThresholdSeconds: 15, // Warn when < 15 seconds remain
        },
      ],
      [
        AggregatorType.ODOS,
        {
          aggregator: AggregatorType.ODOS,
          expirySeconds: 45, // 45 seconds validity (pathId expires faster)
          warningThresholdSeconds: 10, // Warn when < 10 seconds remain
        },
      ],

      // Meta aggregators (longer validity for cross-chain)
      [
        AggregatorType.SOCKET,
        {
          aggregator: AggregatorType.SOCKET,
          expirySeconds: 180,
          warningThresholdSeconds: 60,
        },
      ],
      [
        AggregatorType.RANGO,
        {
          aggregator: AggregatorType.RANGO,
          expirySeconds: 180,
          warningThresholdSeconds: 60,
        },
      ],
      [
        AggregatorType.ROUTER,
        {
          aggregator: AggregatorType.ROUTER,
          expirySeconds: 180,
          warningThresholdSeconds: 60,
        },
      ],

      // Solana routers
      [
        AggregatorType.JUPITER,
        {
          aggregator: AggregatorType.JUPITER,
          expirySeconds: 30, // Very fast expiry
          warningThresholdSeconds: 5,
        },
      ],
      [
        AggregatorType.ORCA,
        {
          aggregator: AggregatorType.ORCA,
          expirySeconds: 30,
          warningThresholdSeconds: 5,
        },
      ],

      // Native L1
      [
        AggregatorType.THORCHAIN,
        {
          aggregator: AggregatorType.THORCHAIN,
          expirySeconds: 300, // 5 minutes for L1 cross-chain
          warningThresholdSeconds: 120, // Warn when < 2 minutes
        },
      ],
    ]);

  /**
   * Check quote expiry status
   */
  checkQuoteExpiry(
    quoteTimestamp: number,
    aggregatorType: AggregatorType,
  ): QuoteExpiryStatus {
    const config = this.expiryConfigs.get(aggregatorType);

    if (!config) {
      this.logger.warn(
        `No expiry config for aggregator: ${aggregatorType}, using defaults`,
      );
      return this.checkWithDefaults(quoteTimestamp, aggregatorType);
    }

    const now = Date.now();
    const ageMs = now - quoteTimestamp;
    const ageSeconds = Math.floor(ageMs / 1000);

    const expiryTimestamp = quoteTimestamp + config.expirySeconds * 1000;
    const remainingMs = expiryTimestamp - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    const isExpired = remainingSeconds <= 0;
    const isNearExpiry =
      remainingSeconds <= config.warningThresholdSeconds && !isExpired;

    const status: QuoteExpiryStatus = {
      isExpired,
      isNearExpiry,
      ageSeconds,
      remainingSeconds,
      expiryTimestamp,
      aggregator: aggregatorType,
    };

    // Add warnings
    if (isExpired) {
      status.warning = `Quote has EXPIRED (age: ${ageSeconds}s, expired ${Math.abs(remainingSeconds)}s ago). Please request a fresh quote.`;
    } else if (isNearExpiry) {
      status.warning = `Quote is near expiry (${remainingSeconds}s remaining). Consider refreshing the quote for better pricing.`;
    }

    // Log warnings
    if (status.warning) {
      this.logger.warn(`[${aggregatorType}] ${status.warning}`);
    }

    return status;
  }

  /**
   * Check with default configuration (fallback)
   */
  private checkWithDefaults(
    quoteTimestamp: number,
    aggregatorType: AggregatorType,
  ): QuoteExpiryStatus {
    const defaultExpirySeconds = 60;
    const defaultWarningSeconds = 15;

    const now = Date.now();
    const ageMs = now - quoteTimestamp;
    const ageSeconds = Math.floor(ageMs / 1000);

    const expiryTimestamp = quoteTimestamp + defaultExpirySeconds * 1000;
    const remainingMs = expiryTimestamp - now;
    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

    const isExpired = remainingSeconds <= 0;
    const isNearExpiry =
      remainingSeconds <= defaultWarningSeconds && !isExpired;

    return {
      isExpired,
      isNearExpiry,
      ageSeconds,
      remainingSeconds,
      expiryTimestamp,
      aggregator: aggregatorType,
      warning: isExpired
        ? `Quote has EXPIRED (age: ${ageSeconds}s). Please request a fresh quote.`
        : isNearExpiry
          ? `Quote is near expiry (${remainingSeconds}s remaining).`
          : undefined,
    };
  }

  /**
   * Validate quote is not expired (throws if expired)
   */
  validateNotExpired(
    quoteTimestamp: number,
    aggregatorType: AggregatorType,
  ): void {
    const status = this.checkQuoteExpiry(quoteTimestamp, aggregatorType);

    if (status.isExpired) {
      throw new Error(
        `Quote has expired. Age: ${status.ageSeconds}s, Expired: ${Math.abs(status.remainingSeconds)}s ago. Please request a fresh quote.`,
      );
    }
  }

  /**
   * Get remaining time percentage (0-100)
   */
  getRemainingTimePercentage(
    quoteTimestamp: number,
    aggregatorType: AggregatorType,
  ): number {
    const config = this.expiryConfigs.get(aggregatorType);
    if (!config) {
      return 0;
    }

    const status = this.checkQuoteExpiry(quoteTimestamp, aggregatorType);
    if (status.isExpired) {
      return 0;
    }

    const totalSeconds = config.expirySeconds;
    return Math.round((status.remainingSeconds / totalSeconds) * 100);
  }

  /**
   * Get expiry configuration for aggregator
   */
  getExpiryConfig(
    aggregatorType: AggregatorType,
  ): QuoteExpiryConfig | undefined {
    return this.expiryConfigs.get(aggregatorType);
  }

  /**
   * Set custom expiry configuration
   */
  setExpiryConfig(config: QuoteExpiryConfig): void {
    this.expiryConfigs.set(config.aggregator, config);
    this.logger.log(
      `Updated expiry config for ${config.aggregator}: ${config.expirySeconds}s`,
    );
  }

  /**
   * Get all expiry configurations
   */
  getAllExpiryConfigs(): QuoteExpiryConfig[] {
    return Array.from(this.expiryConfigs.values());
  }

  /**
   * Check if quote should be refreshed
   * Returns true if quote is expired or near expiry
   */
  shouldRefreshQuote(
    quoteTimestamp: number,
    aggregatorType: AggregatorType,
  ): boolean {
    const status = this.checkQuoteExpiry(quoteTimestamp, aggregatorType);
    return status.isExpired || status.isNearExpiry;
  }

  /**
   * Get human-readable time remaining
   */
  getTimeRemainingFormatted(
    quoteTimestamp: number,
    aggregatorType: AggregatorType,
  ): string {
    const status = this.checkQuoteExpiry(quoteTimestamp, aggregatorType);

    if (status.isExpired) {
      return `Expired ${Math.abs(status.remainingSeconds)}s ago`;
    }

    if (status.remainingSeconds < 60) {
      return `${status.remainingSeconds}s remaining`;
    }

    const minutes = Math.floor(status.remainingSeconds / 60);
    const seconds = status.remainingSeconds % 60;
    return `${minutes}m ${seconds}s remaining`;
  }

  /**
   * Batch check multiple quotes
   */
  checkMultipleQuotes(
    quotes: Array<{
      timestamp: number;
      aggregator: AggregatorType;
      id?: string;
    }>,
  ): Array<QuoteExpiryStatus & { quoteId?: string }> {
    return quotes.map((quote) => ({
      ...this.checkQuoteExpiry(quote.timestamp, quote.aggregator),
      quoteId: quote.id,
    }));
  }

  /**
   * Get aggregators with expired quotes
   */
  getExpiredAggregators(
    quotes: Array<{ timestamp: number; aggregator: AggregatorType }>,
  ): AggregatorType[] {
    const statuses = this.checkMultipleQuotes(quotes);
    return statuses
      .filter((s) => s.isExpired)
      .map((s) => s.aggregator as AggregatorType);
  }
}
