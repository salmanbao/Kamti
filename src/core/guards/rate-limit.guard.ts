import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  OnModuleInit,
} from '@nestjs/common';

/**
 * Simple rate limiting guard (in production, use Redis-based rate limiting)
 */
@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleInit {
  private readonly requests = new Map<
    string,
    { count: number; resetTime: number }
  >();
  private readonly maxRequests = 100; // requests per window
  private readonly windowMs = 60 * 1000; // 1 minute
  private cleanupInterval: NodeJS.Timeout;

  onModuleInit() {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [clientId, data] of this.requests.entries()) {
        if (now > data.resetTime) {
          this.requests.delete(clientId);
        }
      }
    }, this.windowMs);
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const clientId = this.getClientId(request);
    const now = Date.now();

    const clientData = this.requests.get(clientId);

    if (!clientData || now > clientData.resetTime) {
      this.requests.set(clientId, {
        count: 1,
        resetTime: now + this.windowMs,
      });
      return true;
    }

    if (clientData.count >= this.maxRequests) {
      throw new HttpException(
        {
          message: 'Rate limit exceeded',
          retryAfter: Math.ceil((clientData.resetTime - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    clientData.count++;
    return true;
  }

  private getClientId(request: any): string {
    // Use IP address as client identifier
    return request.ip || request.connection.remoteAddress || 'unknown';
  }
}
