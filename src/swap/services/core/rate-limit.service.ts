import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { AggregatorType } from '../../models/swap-request.model';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  aggregator: AggregatorType;
  requestsPerSecond: number;
  burstSize?: number;
  enabled: boolean;
}

/**
 * Rate limit statistics
 */
export interface RateLimitStats {
  aggregator: string;
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  currentRate: number;
  lastReset: Date;
}

/**
 * Token bucket for rate limiting
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token
   */
  tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Get current token count
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Reset bucket
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}

/**
 * Rate limiting service for aggregators
 * Implements token bucket algorithm for smooth rate limiting
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly logger: WinstonLoggerService) {
    this.logger.setContext(RateLimitService.name);
  }

  // Token buckets per aggregator
  private buckets = new Map<AggregatorType, TokenBucket>();

  // Statistics per aggregator
  private stats = new Map<
    AggregatorType,
    {
      totalRequests: number;
      allowedRequests: number;
      blockedRequests: number;
      lastReset: Date;
    }
  >();

  /**
   * Default rate limit configurations
   */
  private configs: Map<AggregatorType, RateLimitConfig> = new Map([
    // EVM aggregators
    [
      AggregatorType.ZEROX,
      {
        aggregator: AggregatorType.ZEROX,
        requestsPerSecond: 10,
        burstSize: 20,
        enabled: true,
      },
    ],
    [
      AggregatorType.ODOS,
      {
        aggregator: AggregatorType.ODOS,
        requestsPerSecond: 5,
        burstSize: 10,
        enabled: true,
      },
    ],

    // Meta aggregators
    [
      AggregatorType.SOCKET,
      {
        aggregator: AggregatorType.SOCKET,
        requestsPerSecond: 3,
        burstSize: 5,
        enabled: true,
      },
    ],
    [
      AggregatorType.RANGO,
      {
        aggregator: AggregatorType.RANGO,
        requestsPerSecond: 3,
        burstSize: 5,
        enabled: true,
      },
    ],
    [
      AggregatorType.ROUTER,
      {
        aggregator: AggregatorType.ROUTER,
        requestsPerSecond: 3,
        burstSize: 5,
        enabled: true,
      },
    ],

    // Solana routers
    [
      AggregatorType.JUPITER,
      {
        aggregator: AggregatorType.JUPITER,
        requestsPerSecond: 10,
        burstSize: 15,
        enabled: true,
      },
    ],
    [
      AggregatorType.ORCA,
      {
        aggregator: AggregatorType.ORCA,
        requestsPerSecond: 5,
        burstSize: 10,
        enabled: true,
      },
    ],

    // Native L1
    [
      AggregatorType.THORCHAIN,
      {
        aggregator: AggregatorType.THORCHAIN,
        requestsPerSecond: 2,
        burstSize: 3,
        enabled: true,
      },
    ],
  ]);

  /**
   * Check if request is allowed
   */
  async checkRateLimit(aggregator: AggregatorType): Promise<boolean> {
    const config = this.configs.get(aggregator);

    if (!config || !config.enabled) {
      // No rate limit or disabled
      return true;
    }

    // Get or create bucket
    let bucket = this.buckets.get(aggregator);
    if (!bucket) {
      bucket = new TokenBucket(
        config.burstSize || config.requestsPerSecond,
        config.requestsPerSecond,
      );
      this.buckets.set(aggregator, bucket);
    }

    // Get or create stats
    let stat = this.stats.get(aggregator);
    if (!stat) {
      stat = {
        totalRequests: 0,
        allowedRequests: 0,
        blockedRequests: 0,
        lastReset: new Date(),
      };
      this.stats.set(aggregator, stat);
    }

    // Update stats
    stat.totalRequests++;

    // Try to consume token
    const allowed = bucket.tryConsume();

    if (allowed) {
      stat.allowedRequests++;
    } else {
      stat.blockedRequests++;
      this.logger.warn(
        `Rate limit exceeded for ${aggregator} (${stat.blockedRequests} blocked)`,
      );
    }

    return allowed;
  }

  /**
   * Execute with rate limit check
   */
  async executeWithRateLimit<T>(
    aggregator: AggregatorType,
    fn: () => Promise<T>,
    maxWaitMs = 5000,
  ): Promise<T> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const allowed = await this.checkRateLimit(aggregator);

      if (allowed) {
        return await fn();
      }

      // Wait and retry
      await this.sleep(100);
    }

    throw new Error(
      `Rate limit exceeded for ${aggregator} (waited ${maxWaitMs}ms)`,
    );
  }

  /**
   * Get rate limit configuration
   */
  getConfig(aggregator: AggregatorType): RateLimitConfig | undefined {
    return this.configs.get(aggregator);
  }

  /**
   * Set rate limit configuration
   */
  setConfig(config: RateLimitConfig): void {
    this.configs.set(config.aggregator, config);

    // Reset bucket to apply new config
    const bucket = this.buckets.get(config.aggregator);
    if (bucket) {
      bucket.reset();
    }

    this.logger.log(
      `Updated rate limit for ${config.aggregator}: ${config.requestsPerSecond} req/s`,
    );
  }

  /**
   * Get all configurations
   */
  getAllConfigs(): RateLimitConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Get statistics for aggregator
   */
  getStats(aggregator: AggregatorType): RateLimitStats | null {
    const stat = this.stats.get(aggregator);
    const config = this.configs.get(aggregator);
    const bucket = this.buckets.get(aggregator);

    if (!stat || !config) {
      return null;
    }

    return {
      aggregator,
      totalRequests: stat.totalRequests,
      allowedRequests: stat.allowedRequests,
      blockedRequests: stat.blockedRequests,
      currentRate: bucket
        ? config.requestsPerSecond - bucket.getAvailableTokens()
        : 0,
      lastReset: stat.lastReset,
    };
  }

  /**
   * Get all statistics
   */
  getAllStats(): RateLimitStats[] {
    const allStats: RateLimitStats[] = [];

    for (const aggregator of this.stats.keys()) {
      const stats = this.getStats(aggregator);
      if (stats) {
        allStats.push(stats);
      }
    }

    return allStats;
  }

  /**
   * Reset statistics for aggregator
   */
  resetStats(aggregator: AggregatorType): void {
    const stat = this.stats.get(aggregator);
    if (stat) {
      stat.totalRequests = 0;
      stat.allowedRequests = 0;
      stat.blockedRequests = 0;
      stat.lastReset = new Date();
    }

    const bucket = this.buckets.get(aggregator);
    if (bucket) {
      bucket.reset();
    }

    this.logger.log(`Reset rate limit stats for ${aggregator}`);
  }

  /**
   * Reset all statistics
   */
  resetAllStats(): void {
    for (const aggregator of this.stats.keys()) {
      this.resetStats(aggregator);
    }
    this.logger.log('Reset all rate limit statistics');
  }

  /**
   * Enable rate limiting for aggregator
   */
  enable(aggregator: AggregatorType): void {
    const config = this.configs.get(aggregator);
    if (config) {
      config.enabled = true;
      this.logger.log(`Enabled rate limiting for ${aggregator}`);
    }
  }

  /**
   * Disable rate limiting for aggregator
   */
  disable(aggregator: AggregatorType): void {
    const config = this.configs.get(aggregator);
    if (config) {
      config.enabled = false;
      this.logger.log(`Disabled rate limiting for ${aggregator}`);
    }
  }

  /**
   * Get available tokens for aggregator
   */
  getAvailableTokens(aggregator: AggregatorType): number {
    const bucket = this.buckets.get(aggregator);
    return bucket ? bucket.getAvailableTokens() : 0;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
