import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Webhook notification payload
 */
export interface WebhookPayload {
  event: 'swap.completed' | 'swap.failed';
  executionId: string;
  jobId: string;
  timestamp: number;
  data: {
    success: boolean;
    transactionHash?: string;
    outputAmount?: string;
    swapType?: string;
    provider?: string;
    fullResult?: any; // Complete ExecutionData object
    error?: {
      message: string;
      code?: string;
    };
    duration?: number;
  };
}

/**
 * Webhook retry configuration
 */
export interface WebhookRetryConfig {
  maxAttempts: number;
  delays: number[]; // Delay in milliseconds for each attempt
}

/**
 * Webhook Service
 *
 * Handles HTTP POST notifications to webhook URLs when async jobs complete or fail.
 *
 * Features:
 * - Automatic retry with exponential backoff (3 attempts: 5s, 15s, 45s)
 * - HMAC-SHA256 signature for payload verification
 * - Timeout handling (10 seconds per request)
 * - Error logging and tracking
 *
 * Usage:
 * ```typescript
 * await webhookService.notify(
 *   'https://api.example.com/webhooks/swap',
 *   payload,
 *   'secret_key'
 * );
 * ```
 */
@Injectable()
export class WebhookService {
  private readonly defaultRetryConfig: WebhookRetryConfig = {
    maxAttempts: 3,
    delays: [5000, 15000, 45000], // 5s, 15s, 45s
  };

  private readonly requestTimeout = 10000; // 10 seconds

  constructor(
    private readonly httpService: HttpService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(WebhookService.name);
  }

  /**
   * Send webhook notification with automatic retry
   *
   * @param url - Webhook URL to POST to
   * @param payload - Webhook payload data
   * @param secret - Optional secret key for HMAC signature
   * @param retryConfig - Optional retry configuration
   * @returns Success status
   */
  async notify(
    url: string,
    payload: WebhookPayload,
    secret?: string,
    retryConfig?: WebhookRetryConfig,
  ): Promise<boolean> {
    const config = retryConfig || this.defaultRetryConfig;

    this.logger.log(`📤 Sending webhook notification to ${url}`, {
      event: payload.event,
      executionId: payload.executionId,
      jobId: payload.jobId,
    });

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        const success = await this.sendWebhook(url, payload, secret, attempt);

        if (success) {
          this.logger.log(`✅ Webhook delivered successfully to ${url}`, {
            attempt,
            executionId: payload.executionId,
          });
          return true;
        }
      } catch (error) {
        this.logger.error(`❌ Webhook attempt ${attempt} failed`, {
          url,
          executionId: payload.executionId,
          error: error.message,
          stack: error.stack,
        });

        // Wait before next retry (if not last attempt)
        if (attempt < config.maxAttempts) {
          const delay =
            config.delays[attempt - 1] ||
            config.delays[config.delays.length - 1];
          this.logger.log(
            `⏳ Retrying webhook in ${delay}ms (attempt ${attempt + 1}/${config.maxAttempts})`,
          );
          await this.sleep(delay);
        }
      }
    }

    this.logger.error(
      `❌ Webhook delivery failed after ${config.maxAttempts} attempts`,
      {
        url,
        executionId: payload.executionId,
      },
    );

    return false;
  }

  /**
   * Send single webhook request
   *
   * @param url - Webhook URL
   * @param payload - Payload data
   * @param secret - Optional HMAC secret
   * @param attempt - Current attempt number
   * @returns Success status
   */
  private async sendWebhook(
    url: string,
    payload: WebhookPayload,
    secret: string | undefined,
    attempt: number,
  ): Promise<boolean> {
    const body = JSON.stringify(payload);

    // Generate HMAC signature if secret provided
    const signature = secret ? this.generateSignature(body, secret) : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'A-Bot-Swap-Aggregator/1.0',
      'X-Webhook-Attempt': attempt.toString(),
    };

    if (signature) {
      headers['X-Webhook-Signature'] = signature;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, body, {
          headers,
          timeout: this.requestTimeout,
          maxRedirects: 0,
        }),
      );

      // Consider 2xx status codes as success
      if (response.status >= 200 && response.status < 300) {
        this.logger.debug(`Webhook response: ${response.status}`, {
          url,
          statusText: response.statusText,
        });
        return true;
      }

      this.logger.warn(`Webhook returned non-2xx status: ${response.status}`, {
        url,
        statusText: response.statusText,
      });
      return false;
    } catch (error) {
      // Log error details
      if (error.response) {
        // HTTP error (4xx, 5xx)
        this.logger.error(`Webhook HTTP error: ${error.response.status}`, {
          url,
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        });
      } else if (error.code === 'ECONNABORTED') {
        // Timeout
        this.logger.error('Webhook timeout', {
          url,
          timeout: this.requestTimeout,
        });
      } else if (error.code) {
        // Network error (ECONNREFUSED, ENOTFOUND, etc.)
        this.logger.error(`Webhook network error: ${error.code}`, {
          url,
          message: error.message,
        });
      } else {
        // Unknown error
        this.logger.error('Webhook unknown error', {
          url,
          error: error.message,
        });
      }

      throw error;
    }
  }

  /**
   * Generate HMAC-SHA256 signature for payload
   *
   * @param payload - JSON string payload
   * @param secret - Secret key
   * @returns Hex-encoded signature
   */
  private generateSignature(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  /**
   * Verify webhook signature
   *
   * @param payload - JSON string payload
   * @param signature - Signature to verify
   * @param secret - Secret key
   * @returns True if signature is valid
   */
  static verifySignature(
    payload: string,
    signature: string,
    secret: string,
  ): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  }

  /**
   * Sleep for specified milliseconds
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Validate webhook URL format
   *
   * @param url - URL to validate
   * @returns True if URL is valid
   */
  static isValidWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Build webhook payload for completed job
   *
   * @param executionId - Execution ID
   * @param jobId - Job ID
   * @param result - Job result data
   * @returns Webhook payload
   */
  static buildCompletedPayload(
    executionId: string,
    jobId: string,
    result: {
      success: boolean;
      transactionHash?: string;
      outputAmount?: string;
      swapType?: string;
      provider?: string;
      fullResult?: any; // Complete ExecutionData object
      duration?: number;
      error?: { message: string; code?: string };
    },
  ): WebhookPayload {
    return {
      event: 'swap.completed',
      executionId,
      jobId,
      timestamp: Date.now(),
      data: result,
    };
  }

  /**
   * Build webhook payload for failed job
   *
   * @param executionId - Execution ID
   * @param jobId - Job ID
   * @param error - Error details
   * @returns Webhook payload
   */
  static buildFailedPayload(
    executionId: string,
    jobId: string,
    error: { message: string; code?: string },
  ): WebhookPayload {
    return {
      event: 'swap.failed',
      executionId,
      jobId,
      timestamp: Date.now(),
      data: {
        success: false,
        error,
      },
    };
  }
}
