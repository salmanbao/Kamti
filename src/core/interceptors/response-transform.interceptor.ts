import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Response transformation interceptor to standardize API responses
 */
@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<
  T,
  any
> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        // If the response is already wrapped (has 'success' field), just add timestamp if missing
        if (data && typeof data === 'object') {
          if ('statusCode' in data) {
            return data;
          }

          // If response already has 'success' field, it's already formatted
          if ('success' in data) {
            // Add timestamp if not already present
            return data.timestamp
              ? data
              : { ...data, timestamp: new Date().toISOString() };
          }
        }

        // Transform unwrapped responses to a standard format
        return {
          success: true,
          data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
