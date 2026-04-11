import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: string[];
}

/**
 * Retry attempt result
 */
export interface RetryAttempt<T> {
  attempt: number;
  success: boolean;
  result?: T;
  error?: Error;
  delayMs?: number;
  totalElapsedMs: number;
}

/**
 * Retry statistics
 */
export interface RetryStats {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  averageAttempts: number;
  totalElapsedMs: number;
}

/**
 * Transaction retry service with exponential backoff
 * Handles retrying failed transactions with intelligent backoff strategies
 */
@Injectable()
export class TransactionRetryService {
  constructor(private readonly logger: WinstonLoggerService) {
    this.logger.setContext(TransactionRetryService.name);
  }

  // Retry statistics
  private stats = {
    totalAttempts: 0,
    successCount: 0,
    failureCount: 0,
    totalElapsedMs: 0,
  };

  /**
   * Default retry configuration
   */
  private readonly defaultConfig: RetryConfig = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryableErrors: [
      'nonce too low',
      'replacement transaction underpriced',
      'transaction underpriced',
      'insufficient funds for gas',
      'timeout',
      'network error',
      'connection error',
      'ETIMEDOUT',
      'ECONNRESET',
      'ENOTFOUND',
      'rate limit',
      '429',
      'too many requests',
    ],
  };

  /**
   * Execute function with retry logic
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    config?: Partial<RetryConfig>,
    context?: string,
  ): Promise<T> {
    const finalConfig = { ...this.defaultConfig, ...config };
    const attempts: RetryAttempt<T>[] = [];
    const startTime = Date.now();

    for (let attempt = 1; attempt <= finalConfig.maxAttempts; attempt++) {
      try {
        this.logger.debug(
          `[${context || 'Retry'}] Attempt ${attempt}/${finalConfig.maxAttempts}`,
        );

        const result = await fn();

        // Success!
        const elapsed = Date.now() - startTime;
        attempts.push({
          attempt,
          success: true,
          result,
          totalElapsedMs: elapsed,
        });

        this.stats.totalAttempts += attempt;
        this.stats.successCount++;
        this.stats.totalElapsedMs += elapsed;

        if (attempt > 1) {
          this.logger.log(
            `[${context || 'Retry'}] SUCCESS after ${attempt} attempts (${elapsed}ms)`,
          );
        }

        return result;
      } catch (error) {
        const elapsed = Date.now() - startTime;
        attempts.push({
          attempt,
          success: false,
          error: error as Error,
          totalElapsedMs: elapsed,
        });

        const isLastAttempt = attempt === finalConfig.maxAttempts;
        const isRetryable = this.isRetryableError(error, finalConfig);

        this.logger.warn(
          `[${context || 'Retry'}] Attempt ${attempt} failed: ${error.message}`,
        );

        if (isLastAttempt || !isRetryable) {
          // Final failure or non-retryable error
          this.stats.totalAttempts += attempt;
          this.stats.failureCount++;
          this.stats.totalElapsedMs += elapsed;

          if (!isRetryable) {
            this.logger.error(
              `[${context || 'Retry'}] Non-retryable error: ${error.message}`,
            );
          } else {
            this.logger.error(
              `[${context || 'Retry'}] FAILED after ${attempt} attempts (${elapsed}ms)`,
            );
          }

          throw error;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt, finalConfig);
        attempts[attempt - 1].delayMs = delay;

        this.logger.debug(
          `[${context || 'Retry'}] Waiting ${delay}ms before retry ${attempt + 1}`,
        );

        await this.sleep(delay);
      }
    }

    // Should never reach here
    throw new Error(
      'Retry logic error: exceeded max attempts without throwing',
    );
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateDelay(attempt: number, config: RetryConfig): number {
    const exponentialDelay =
      config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);

    // Add jitter (±20%) to prevent thundering herd
    const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5);
    const delayWithJitter = exponentialDelay + jitter;

    // Cap at max delay
    return Math.min(delayWithJitter, config.maxDelayMs);
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: any, config: RetryConfig): boolean {
    if (!error || !config.retryableErrors) {
      return false;
    }

    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code?.toLowerCase() || '';
    const errorString = error.toString().toLowerCase();

    // Check against retryable error patterns
    return config.retryableErrors.some((pattern) => {
      const patternLower = pattern.toLowerCase();
      return (
        errorMessage.includes(patternLower) ||
        errorCode.includes(patternLower) ||
        errorString.includes(patternLower)
      );
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute transaction with nonce management retry
   * Special handling for nonce-related errors
   */
  async executeTransactionWithRetry<T>(
    fn: () => Promise<T>,
    config?: Partial<RetryConfig>,
    context?: string,
  ): Promise<T> {
    const txConfig: RetryConfig = {
      ...this.defaultConfig,
      maxAttempts: 5, // More attempts for transactions
      retryableErrors: [
        ...(this.defaultConfig.retryableErrors || []),
        'nonce has already been used',
        'known transaction',
        'already known',
      ],
      ...config,
    };

    return this.executeWithRetry(fn, txConfig, context || 'Transaction');
  }

  /**
   * Execute RPC call with retry
   * Optimized for RPC failures
   */
  async executeRpcWithRetry<T>(
    fn: () => Promise<T>,
    config?: Partial<RetryConfig>,
    context?: string,
  ): Promise<T> {
    const rpcConfig: RetryConfig = {
      ...this.defaultConfig,
      maxAttempts: 4,
      initialDelayMs: 500,
      retryableErrors: [
        'timeout',
        'network error',
        'connection error',
        'ETIMEDOUT',
        'ECONNRESET',
        'ENOTFOUND',
        'rate limit',
        '429',
        'too many requests',
        'service unavailable',
        '503',
        'bad gateway',
        '502',
      ],
      ...config,
    };

    return this.executeWithRetry(fn, rpcConfig, context || 'RPC');
  }

  /**
   * Execute API call with retry
   * Optimized for external API failures
   */
  async executeApiWithRetry<T>(
    fn: () => Promise<T>,
    config?: Partial<RetryConfig>,
    context?: string,
  ): Promise<T> {
    const apiConfig: RetryConfig = {
      ...this.defaultConfig,
      maxAttempts: 3,
      initialDelayMs: 2000,
      maxDelayMs: 15000,
      retryableErrors: [
        'timeout',
        'ETIMEDOUT',
        'ECONNRESET',
        'rate limit',
        '429',
        'too many requests',
        'service unavailable',
        '503',
        'bad gateway',
        '502',
        'gateway timeout',
        '504',
      ],
      ...config,
    };

    return this.executeWithRetry(fn, apiConfig, context || 'API');
  }

  /**
   * Get retry statistics
   */
  getStats(): RetryStats {
    const avgAttempts =
      this.stats.successCount + this.stats.failureCount > 0
        ? this.stats.totalAttempts /
          (this.stats.successCount + this.stats.failureCount)
        : 0;

    return {
      totalAttempts: this.stats.totalAttempts,
      successCount: this.stats.successCount,
      failureCount: this.stats.failureCount,
      averageAttempts: Math.round(avgAttempts * 100) / 100,
      totalElapsedMs: this.stats.totalElapsedMs,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalAttempts: 0,
      successCount: 0,
      failureCount: 0,
      totalElapsedMs: 0,
    };
    this.logger.log('Retry statistics reset');
  }

  /**
   * Check if error should trigger immediate failure (non-retryable)
   */
  isNonRetryableError(error: any): boolean {
    const errorMessage = error.message?.toLowerCase() || '';

    const nonRetryablePatterns = [
      'insufficient funds',
      'gas required exceeds allowance',
      'execution reverted',
      'invalid signature',
      'invalid address',
      'unauthorized',
      'forbidden',
      '401',
      '403',
      'not found',
      '404',
    ];

    return nonRetryablePatterns.some((pattern) =>
      errorMessage.includes(pattern),
    );
  }

  /**
   * Batch retry multiple operations
   */
  async batchRetry<T>(
    operations: Array<() => Promise<T>>,
    config?: Partial<RetryConfig>,
  ): Promise<Array<{ success: boolean; result?: T; error?: Error }>> {
    const results = await Promise.allSettled(
      operations.map((op, index) =>
        this.executeWithRetry(op, config, `Batch-${index + 1}`),
      ),
    );

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return { success: true, result: result.value };
      } else {
        return { success: false, error: result.reason };
      }
    });
  }

  /**
   * Get recommended retry config for error type
   */
  getRecommendedConfig(errorType: 'transaction' | 'rpc' | 'api'): RetryConfig {
    switch (errorType) {
      case 'transaction':
        return {
          ...this.defaultConfig,
          maxAttempts: 5,
          initialDelayMs: 2000,
        };
      case 'rpc':
        return {
          ...this.defaultConfig,
          maxAttempts: 4,
          initialDelayMs: 500,
        };
      case 'api':
        return {
          ...this.defaultConfig,
          maxAttempts: 3,
          initialDelayMs: 2000,
          maxDelayMs: 15000,
        };
      default:
        return this.defaultConfig;
    }
  }
}
