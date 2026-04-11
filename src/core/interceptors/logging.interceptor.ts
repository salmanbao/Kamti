import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Logging interceptor to log all HTTP requests and responses
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(LoggingInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, body, query, params } = request;
    const userAgent = request.get('User-Agent') || '';
    const ip = request.ip;

    const startTime = Date.now();

    this.logger.log(
      `Incoming Request: ${method} ${url} - IP: ${ip} - User-Agent: ${userAgent}`,
    );

    if (body && Object.keys(body).length > 0) {
      this.logger.debug(`Request Body: ${this.safeStringify(body)}`);
    }

    if (query && Object.keys(query).length > 0) {
      this.logger.debug(`Query Params: ${this.safeStringify(query)}`);
    }

    if (params && Object.keys(params).length > 0) {
      this.logger.debug(`Route Params: ${this.safeStringify(params)}`);
    }

    return next.handle().pipe(
      tap({
        next: (data) => {
          const duration = Date.now() - startTime;
          this.logger.log(
            `Outgoing Response: ${method} ${url} - ${duration}ms`,
          );
          this.logger.debug(`Response Data: ${this.safeStringify(data)}`);
        },
        error: (error) => {
          const duration = Date.now() - startTime;
          this.logger.error(
            `Request Error: ${method} ${url} - ${duration}ms - ${error?.message || 'Unknown error'}`,
          );
        },
      }),
    );
  }

  /**
   * Safely stringify objects, handling circular references and errors
   */
  private safeStringify(obj: any): string {
    try {
      return JSON.stringify(obj);
    } catch (error) {
      return `[Object - Cannot stringify: ${error.message}]`;
    }
  }
}
