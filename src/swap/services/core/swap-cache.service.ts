import { Injectable, Logger } from '@nestjs/common';
import { RouteQuote } from '@swap/models/ports';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * SwapCacheService
 * Caches supported chain/token pairs from successful quotes for fast lookup and reuse.
 * Also caches RouteQuote objects for execution.
 */
@Injectable()
export class SwapCacheService {
  private supportedChainsTokens = new Map<
    number,
    { buyTokens: Set<string>; sellTokens: Set<string> }
  >();

  // Route cache for execution (10 minute TTL)
  private readonly routeCache = new Map<
    string,
    { route: RouteQuote; expiresAt: number }
  >();
  private readonly routeCacheTtlMs = 10 * 60 * 1000; // 10 minutes

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.winstonLogger.setContext('SwapCacheService');
  }

  addSupportedQuote(chainId: number, buyToken: string, sellToken: string) {
    if (!this.supportedChainsTokens.has(chainId)) {
      this.supportedChainsTokens.set(chainId, {
        buyTokens: new Set(),
        sellTokens: new Set(),
      });
    }
    const entry = this.supportedChainsTokens.get(chainId)!;
    entry.buyTokens.add(buyToken.toLowerCase());
    entry.sellTokens.add(sellToken.toLowerCase());
  }

  isChainSupported(chainId: number, tokenAddress: string): boolean {
    const entry = this.supportedChainsTokens.get(chainId);
    if (!entry) return false;
    const addr = tokenAddress.toLowerCase();
    return entry.buyTokens.has(addr) || entry.sellTokens.has(addr);
  }

  /**
   * Cache a route quote for later execution
   */
  cacheRoute(routeId: string, route: RouteQuote): void {
    const ttlMs = this.calculateRouteTtlMs(route);

    if (ttlMs <= 0) {
      this.winstonLogger.warn(
        `Skipping cache for route ${routeId} because it is already expired`,
      );
      return;
    }

    const expiresAt = Date.now() + ttlMs;
    this.routeCache.set(routeId, { route, expiresAt });

    // Audit log route caching
    this.winstonLogger.audit('ROUTE_CACHE_SET', {
      routeId,
      totalSteps: route.steps.length,
      totalEstimatedOut: route.totalEstimatedOut,
      ttlSeconds: ttlMs / 1000,
      totalCachedRoutes: this.routeCache.size,
      timestamp: new Date().toISOString(),
    });

    this.winstonLogger.debug(
      `Cached route ${routeId} (expires in ${ttlMs / 1000}s)`,
    );
  }

  /**
   * Get a cached route by ID
   * Returns undefined if not found or expired
   */
  getRoute(routeId: string): RouteQuote | undefined {
    const cached = this.routeCache.get(routeId);

    if (!cached) {
      // Audit log cache miss
      this.winstonLogger.audit('ROUTE_CACHE_MISS', {
        routeId,
        reason: 'not_found',
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.warn(`Route ${routeId} not found in cache`);
      return undefined;
    }

    // Check expiration
    if (Date.now() > cached.expiresAt) {
      // Audit log cache miss due to expiration
      this.winstonLogger.audit('ROUTE_CACHE_MISS', {
        routeId,
        reason: 'expired',
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.warn(`Route ${routeId} expired`);
      this.routeCache.delete(routeId);
      return undefined;
    }

    // Audit log cache hit
    this.winstonLogger.audit('ROUTE_CACHE_HIT', {
      routeId,
      remainingTtlSeconds: Math.round((cached.expiresAt - Date.now()) / 1000),
      timestamp: new Date().toISOString(),
    });

    return cached.route;
  }

  /**
   * Remove a route from cache (e.g., after execution)
   */
  deleteRoute(routeId: string): void {
    const existed = this.routeCache.has(routeId);
    this.routeCache.delete(routeId);

    // Audit log route deletion
    if (existed) {
      this.winstonLogger.audit('ROUTE_CACHE_DELETE', {
        routeId,
        totalCachedRoutes: this.routeCache.size,
        timestamp: new Date().toISOString(),
      });
    }

    this.winstonLogger.debug(`Deleted route ${routeId} from cache`);
  }

  clearCache() {
    const routeCount = this.routeCache.size;
    const chainCount = this.supportedChainsTokens.size;

    this.supportedChainsTokens.clear();
    this.routeCache.clear();

    // Audit log cache clear
    this.winstonLogger.audit('CACHE_CLEARED', {
      routesCleared: routeCount,
      chainsCleared: chainCount,
      timestamp: new Date().toISOString(),
    });
  }

  getCacheSnapshot() {
    // For debugging/testing
    return {
      supportedChains: Array.from(this.supportedChainsTokens.entries()).map(
        ([chainId, tokens]) => ({
          chainId,
          buyTokens: Array.from(tokens.buyTokens),
          sellTokens: Array.from(tokens.sellTokens),
        }),
      ),
      cachedRoutes: Array.from(this.routeCache.keys()),
    };
  }

  private calculateRouteTtlMs(route: RouteQuote): number {
    const now = Date.now();
    const providerExpiresAt = (route.providerRef as any)?.expiresAt;
    const targetExpiry = route.expiresAt || providerExpiresAt;

    if (targetExpiry) {
      const remaining = targetExpiry - now;
      if (remaining <= 0) {
        return 0;
      }
      return Math.min(this.routeCacheTtlMs, remaining);
    }

    return this.routeCacheTtlMs;
  }
}
