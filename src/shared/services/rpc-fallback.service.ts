import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from './winston-logger.service';

/**
 * Health status for individual RPC URLs
 */
interface RpcUrlHealth {
  url: string;
  isHealthy: boolean;
  lastCheck: Date;
  successCount: number;
  failureCount: number;
  totalRequests: number;
  averageResponseTime: number;
  consecutiveFailures: number;
  lastError?: string;
}

/**
 * Configuration for RPC fallback behavior
 */
interface RpcFallbackConfig {
  maxRetries?: number; // Max retries per URL (default: 2)
  timeout?: number; // Request timeout in ms (default: 10000)
  maxConsecutiveFailures?: number; // Max failures before marking URL unhealthy (default: 3)
  healthCheckInterval?: number; // Interval for health checks in ms (default: 60000)
  enableHealthCheck?: boolean; // Enable periodic health checks (default: true)
}

/**
 * Options for making RPC requests
 */
interface RpcRequestOptions {
  method?: string; // HTTP method (default: 'POST')
  headers?: Record<string, string>; // Additional headers
  body?: any; // Request body
  timeout?: number; // Override default timeout
  retries?: number; // Override max retries
}

/**
 * RPC Fallback Service
 *
 * Provides intelligent RPC endpoint fallback with:
 * - Automatic URL rotation on failures
 * - Health monitoring per endpoint
 * - Request retry logic
 * - Response time tracking
 * - Automatic unhealthy endpoint detection
 *
 * Features:
 * - Multiple URL support with automatic failover
 * - Health status tracking for each URL
 * - Configurable retry and timeout behavior
 * - Periodic health checks (optional)
 * - Detailed logging of failures and URL switches
 *
 * Usage:
 * ```typescript
 * const urls = ['https://rpc1.example.com', 'https://rpc2.example.com'];
 * const result = await rpcFallback.makeRequest(urls, {
 *   method: 'POST',
 *   body: { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }
 * });
 * ```
 */
@Injectable()
export class RpcFallbackService {
  private readonly logger: WinstonLoggerService;

  // Health tracking for all URLs
  private urlHealthMap = new Map<string, RpcUrlHealth>();

  // Default configuration
  private readonly defaultConfig: Required<RpcFallbackConfig> = {
    maxRetries: 2,
    timeout: 10000, // 10 seconds
    maxConsecutiveFailures: 3,
    healthCheckInterval: 60000, // 1 minute
    enableHealthCheck: true,
  };

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(RpcFallbackService.name);
    this.logger.log('✅ RPC Fallback Service initialized');
  }

  /**
   * Make an RPC request with automatic fallback
   * Tries each URL in sequence until one succeeds
   *
   * @param urls - Array of RPC URLs to try (in order of preference)
   * @param options - Request options (method, body, headers, etc.)
   * @param config - Fallback configuration (retries, timeout, etc.)
   * @returns Response from the first successful RPC call
   * @throws Error if all URLs fail
   */
  async makeRequest<T = any>(
    urls: string | string[],
    options: RpcRequestOptions = {},
    config?: RpcFallbackConfig,
  ): Promise<T> {
    // Normalize URLs to array
    const urlArray = Array.isArray(urls) ? urls : [urls];

    if (urlArray.length === 0) {
      throw new Error('No RPC URLs provided');
    }

    // Merge config with defaults
    const finalConfig = { ...this.defaultConfig, ...config };

    // Initialize health tracking for new URLs
    for (const url of urlArray) {
      if (!this.urlHealthMap.has(url)) {
        this.initializeUrlHealth(url);
      }
    }

    // Sort URLs by health (healthy URLs first)
    const sortedUrls = this.sortUrlsByHealth(urlArray);

    const errors: Array<{ url: string; error: string }> = [];

    // Try each URL
    for (let i = 0; i < sortedUrls.length; i++) {
      const url = sortedUrls[i];
      const health = this.urlHealthMap.get(url)!;

      // Skip unhealthy URLs unless it's the last option
      if (!health.isHealthy && i < sortedUrls.length - 1) {
        this.logger.debug(
          `⚠️ Skipping unhealthy URL: ${this.maskUrl(url)} (${health.consecutiveFailures} consecutive failures)`,
        );
        continue;
      }

      try {
        this.logger.debug(
          `🔄 Attempting RPC request to ${this.maskUrl(url)} (${i + 1}/${sortedUrls.length})`,
        );

        const result = await this.makeRequestToUrl<T>(
          url,
          options,
          finalConfig,
        );

        // Update health on success
        this.recordSuccess(url);

        if (i > 0) {
          this.logger.log(
            `✅ RPC request succeeded with fallback URL #${i + 1}: ${this.maskUrl(url)}`,
          );
        }

        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ url: this.maskUrl(url), error: errorMsg });

        // Update health on failure
        this.recordFailure(url, errorMsg);

        this.logger.warn(
          `❌ RPC request failed for ${this.maskUrl(url)}: ${errorMsg} ` +
            `(${health.consecutiveFailures}/${finalConfig.maxConsecutiveFailures} failures)`,
        );

        // If not the last URL, continue to next
        if (i < sortedUrls.length - 1) {
          continue;
        }
      }
    }

    // All URLs failed
    const errorSummary = errors.map((e) => `${e.url}: ${e.error}`).join('; ');
    throw new Error(`All RPC endpoints failed. Errors: ${errorSummary}`);
  }

  /**
   * Make request to a specific URL with retry logic
   */
  private async makeRequestToUrl<T>(
    url: string,
    options: RpcRequestOptions,
    config: Required<RpcFallbackConfig>,
  ): Promise<T> {
    const maxRetries = options.retries ?? config.maxRetries;
    const timeout = options.timeout ?? config.timeout;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const startTime = Date.now();

        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(url, {
            method: options.method || 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'A-Bot-Microservices/1.0',
              ...options.headers,
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          const responseTime = Date.now() - startTime;
          this.updateResponseTime(url, responseTime);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const data = await response.json();

          // Check for JSON-RPC errors
          if (data.error) {
            throw new Error(
              `RPC Error: ${data.error.message || JSON.stringify(data.error)}`,
            );
          }

          return data as T;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // If timeout or network error, retry
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
          this.logger.debug(
            `⏳ Retry ${attempt + 1}/${maxRetries} for ${this.maskUrl(url)} in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Get the best available URL from a list
   * Returns the first healthy URL, or the first URL if none are healthy
   */
  getBestUrl(urls: string | string[]): string {
    const urlArray = Array.isArray(urls) ? urls : [urls];

    if (urlArray.length === 0) {
      throw new Error('No RPC URLs provided');
    }

    // Initialize health for new URLs
    for (const url of urlArray) {
      if (!this.urlHealthMap.has(url)) {
        this.initializeUrlHealth(url);
      }
    }

    // Sort by health and return the best
    const sorted = this.sortUrlsByHealth(urlArray);
    return sorted[0];
  }

  /**
   * Get health status for a specific URL
   */
  getUrlHealth(url: string): RpcUrlHealth | null {
    return this.urlHealthMap.get(url) || null;
  }

  /**
   * Get health status for all tracked URLs
   */
  getAllUrlHealth(): Map<string, RpcUrlHealth> {
    return new Map(this.urlHealthMap);
  }

  /**
   * Manually mark a URL as healthy or unhealthy
   */
  setUrlHealth(url: string, isHealthy: boolean): void {
    const health = this.urlHealthMap.get(url);
    if (health) {
      health.isHealthy = isHealthy;
      health.consecutiveFailures = isHealthy ? 0 : health.consecutiveFailures;
      health.lastCheck = new Date();
      this.logger.log(
        `🔧 Manually set ${this.maskUrl(url)} health to: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'}`,
      );
    }
  }

  /**
   * Reset health tracking for a URL
   */
  resetUrlHealth(url: string): void {
    this.urlHealthMap.delete(url);
    this.initializeUrlHealth(url);
    this.logger.log(`🔄 Reset health tracking for ${this.maskUrl(url)}`);
  }

  /**
   * Reset health tracking for all URLs
   */
  resetAllHealth(): void {
    const urls = Array.from(this.urlHealthMap.keys());
    this.urlHealthMap.clear();
    urls.forEach((url) => this.initializeUrlHealth(url));
    this.logger.log('🔄 Reset health tracking for all URLs');
  }

  /**
   * Initialize health tracking for a URL
   */
  private initializeUrlHealth(url: string): void {
    this.urlHealthMap.set(url, {
      url,
      isHealthy: true,
      lastCheck: new Date(),
      successCount: 0,
      failureCount: 0,
      totalRequests: 0,
      averageResponseTime: 0,
      consecutiveFailures: 0,
    });
  }

  /**
   * Record a successful request
   */
  private recordSuccess(url: string): void {
    const health = this.urlHealthMap.get(url);
    if (!health) return;

    health.successCount++;
    health.totalRequests++;
    health.consecutiveFailures = 0;
    health.isHealthy = true;
    health.lastCheck = new Date();
    delete health.lastError;
  }

  /**
   * Record a failed request
   */
  private recordFailure(url: string, error: string): void {
    const health = this.urlHealthMap.get(url);
    if (!health) return;

    health.failureCount++;
    health.totalRequests++;
    health.consecutiveFailures++;
    health.lastCheck = new Date();
    health.lastError = error;

    // Mark as unhealthy if too many consecutive failures
    if (
      health.consecutiveFailures >= this.defaultConfig.maxConsecutiveFailures
    ) {
      health.isHealthy = false;
      this.logger.warn(
        `⚠️ Marked ${this.maskUrl(url)} as UNHEALTHY after ${health.consecutiveFailures} consecutive failures`,
      );
    }
  }

  /**
   * Update average response time for a URL
   */
  private updateResponseTime(url: string, responseTime: number): void {
    const health = this.urlHealthMap.get(url);
    if (!health) return;

    // Calculate rolling average
    const totalTime =
      health.averageResponseTime * (health.successCount - 1) + responseTime;
    health.averageResponseTime =
      health.successCount > 0 ? totalTime / health.successCount : responseTime;
  }

  /**
   * Sort URLs by health (healthy first, then by success rate, then by response time)
   */
  private sortUrlsByHealth(urls: string[]): string[] {
    return [...urls].sort((a, b) => {
      const healthA = this.urlHealthMap.get(a)!;
      const healthB = this.urlHealthMap.get(b)!;

      // Healthy URLs first
      if (healthA.isHealthy !== healthB.isHealthy) {
        return healthA.isHealthy ? -1 : 1;
      }

      // Then by success rate
      const successRateA =
        healthA.totalRequests > 0
          ? healthA.successCount / healthA.totalRequests
          : 0;
      const successRateB =
        healthB.totalRequests > 0
          ? healthB.successCount / healthB.totalRequests
          : 0;

      if (successRateA !== successRateB) {
        return successRateB - successRateA; // Higher success rate first
      }

      // Then by response time (faster first)
      return healthA.averageResponseTime - healthB.averageResponseTime;
    });
  }

  /**
   * Mask sensitive parts of URL for logging
   */
  private maskUrl(url: string): string {
    try {
      const urlObj = new URL(url);

      // Mask API keys in query params
      if (urlObj.searchParams.toString()) {
        const maskedParams = Array.from(urlObj.searchParams.keys())
          .map((key) => `${key}=***`)
          .join('&');
        return `${urlObj.origin}${urlObj.pathname}?${maskedParams}`;
      }

      // Mask path if it contains potential API keys (long alphanumeric strings)
      const maskedPath = urlObj.pathname.replace(/[a-zA-Z0-9]{20,}/g, '***');

      return `${urlObj.origin}${maskedPath}`;
    } catch {
      // If URL parsing fails, mask potential API keys in the string
      return url.replace(/[a-zA-Z0-9]{20,}/g, '***');
    }
  }

  /**
   * Get statistics for all URLs
   */
  getStatistics(): {
    totalUrls: number;
    healthyUrls: number;
    unhealthyUrls: number;
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageSuccessRate: number;
  } {
    const allHealth = Array.from(this.urlHealthMap.values());

    const totalRequests = allHealth.reduce(
      (sum, h) => sum + h.totalRequests,
      0,
    );
    const successfulRequests = allHealth.reduce(
      (sum, h) => sum + h.successCount,
      0,
    );
    const failedRequests = allHealth.reduce(
      (sum, h) => sum + h.failureCount,
      0,
    );

    return {
      totalUrls: allHealth.length,
      healthyUrls: allHealth.filter((h) => h.isHealthy).length,
      unhealthyUrls: allHealth.filter((h) => !h.isHealthy).length,
      totalRequests,
      successfulRequests,
      failedRequests,
      averageSuccessRate:
        totalRequests > 0 ? successfulRequests / totalRequests : 0,
    };
  }

  /**
   * Log current health status for debugging
   */
  logHealthStatus(): void {
    const stats = this.getStatistics();

    this.logger.log('📊 RPC Fallback Service Statistics:');
    this.logger.log(
      `  Total URLs: ${stats.totalUrls} (${stats.healthyUrls} healthy, ${stats.unhealthyUrls} unhealthy)`,
    );
    this.logger.log(
      `  Total Requests: ${stats.totalRequests} (${stats.successfulRequests} success, ${stats.failedRequests} failed)`,
    );
    this.logger.log(
      `  Average Success Rate: ${(stats.averageSuccessRate * 100).toFixed(2)}%`,
    );

    // Log individual URL health
    for (const [url, health] of this.urlHealthMap.entries()) {
      const successRate =
        health.totalRequests > 0
          ? ((health.successCount / health.totalRequests) * 100).toFixed(1)
          : 'N/A';
      const status = health.isHealthy ? '✅' : '❌';

      this.logger.debug(
        `  ${status} ${this.maskUrl(url)}: ` +
          `${health.successCount}/${health.totalRequests} success (${successRate}%), ` +
          `avg: ${health.averageResponseTime.toFixed(0)}ms, ` +
          `consecutive failures: ${health.consecutiveFailures}`,
      );
    }
  }
}
