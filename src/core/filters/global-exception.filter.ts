import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { Response } from 'express';

/**
 * Global exception filter to handle all unhandled exceptions
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    let status: number;
    let message: string;
    let error: string;
    let details: any;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = exception.name;
      } else {
        message = (exceptionResponse as any).message || exception.message;
        error = (exceptionResponse as any).error || exception.name;
        // Include validation errors if present
        if ((exceptionResponse as any).errors) {
          details = (exceptionResponse as any).errors;
        }
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      error = 'InternalServerError';
    }

    const errorResponse: any = {
      success: false,
      error: {
        statusCode: status,
        message,
        error,
        path: request.url,
        method: request.method,
      },
      timestamp: new Date().toISOString(),
    };

    // Add details if available (e.g., validation errors)
    if (details) {
      errorResponse.error.details = details;
    }

    this.logger.error(
      `${request.method} ${request.url} - ${status} - ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json(errorResponse);
  }
}
