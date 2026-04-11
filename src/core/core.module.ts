import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, APP_GUARD } from '@nestjs/core';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from './interceptors/response-transform.interceptor';
import { CustomValidationPipe } from './pipes/validation.pipe';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { TokenValidationGuard } from './guards/token-validation.guard';

/**
 * Core Module - Global Application Concerns
 *
 * Provides global filters, interceptors, pipes, and guards that apply to all
 * routes in the application. Registered using NestJS APP_* tokens for global scope.
 *
 * Global Components:
 * - GlobalExceptionFilter: Centralized error handling and formatting
 * - LoggingInterceptor: Request/response logging
 * - ResponseTransformInterceptor: Response transformation and standardization
 * - CustomValidationPipe: DTO validation with detailed error messages
 * - RateLimitGuard: Rate limiting protection
 * - TokenValidationGuard: Token validation for swap operations
 *
 * Note: No exports needed - global providers registered via APP_* tokens are
 * automatically available throughout the application.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseTransformInterceptor,
    },
    {
      provide: APP_PIPE,
      useClass: CustomValidationPipe,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TokenValidationGuard,
    },
  ],
})
export class CoreModule {}
