import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as path from 'path';

/**
 * Winston Logger Service for file-based audit logging
 * Provides structured logging with daily rotation and separate files for different log levels
 */
@Injectable()
export class WinstonLoggerService implements NestLoggerService {
  private logger: winston.Logger;
  private context: string = 'Application';

  constructor() {
    this.initializeLogger();
  }

  /**
   * Initialize Winston logger with multiple transports
   */
  private initializeLogger(): void {
    const logDir = path.join(process.cwd(), 'logs');

    // Custom format for structured logs
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.metadata({
        fillExcept: ['timestamp', 'level', 'message', 'context'],
      }),
      winston.format.json(),
    );

    // Format for console output (human-readable)
    const consoleFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.colorize(),
      winston.format.printf(
        ({ timestamp, level, message, context, ...meta }) => {
          const metaStr = Object.keys(meta).length
            ? ` ${JSON.stringify(meta)}`
            : '';
          return `${timestamp} [${context || 'App'}] ${level}: ${message}${metaStr}`;
        },
      ),
    );

    // Daily rotate file transport for all logs
    const allLogsTransport = new DailyRotateFile({
      filename: path.join(logDir, 'all-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d', // Keep logs for 14 days
      format: logFormat,
    });

    // Daily rotate file transport for error logs
    const errorLogsTransport = new DailyRotateFile({
      level: 'error',
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d', // Keep error logs for 30 days
      format: logFormat,
    });

    // Daily rotate file transport for audit/transaction logs
    const auditLogsTransport = new DailyRotateFile({
      level: 'info',
      filename: path.join(logDir, 'audit-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '50m',
      maxFiles: '90d', // Keep audit logs for 90 days
      format: logFormat,
    });

    // Daily rotate file transport for debug logs
    const debugLogsTransport = new DailyRotateFile({
      level: 'debug',
      filename: path.join(logDir, 'debug-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '7d', // Keep debug logs for 7 days
      format: logFormat,
    });

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      transports: [
        // Console transport (only in development)
        new winston.transports.Console({
          format: consoleFormat,
          silent: process.env.NODE_ENV === 'test',
        }),
        // File transports
        allLogsTransport,
        errorLogsTransport,
        auditLogsTransport,
        debugLogsTransport,
      ],
      exceptionHandlers: [
        new DailyRotateFile({
          filename: path.join(logDir, 'exceptions-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxSize: '20m',
          maxFiles: '30d',
          format: logFormat,
        }),
      ],
      rejectionHandlers: [
        new DailyRotateFile({
          filename: path.join(logDir, 'rejections-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxSize: '20m',
          maxFiles: '30d',
          format: logFormat,
        }),
      ],
    });
  }

  /**
   * Set context for logs
   */
  setContext(context: string): void {
    this.context = context;
  }

  /**
   * Log info level message
   */
  log(message: any, context?: string): void;
  log(message: any, meta?: Record<string, any>): void;
  log(message: any, contextOrMeta?: string | Record<string, any>): void {
    if (typeof contextOrMeta === 'string') {
      this.logger.info(message, { context: contextOrMeta || this.context });
    } else if (contextOrMeta && typeof contextOrMeta === 'object') {
      this.logger.info(message, { context: this.context, ...contextOrMeta });
    } else {
      this.logger.info(message, { context: this.context });
    }
  }

  /**
   * Log error level message
   */
  error(message: any, trace?: string, context?: string): void;
  error(message: any, meta?: Record<string, any>): void;
  error(
    message: any,
    traceOrMeta?: string | Record<string, any>,
    context?: string,
  ): void {
    if (typeof traceOrMeta === 'string') {
      this.logger.error(message, {
        context: context || this.context,
        trace: traceOrMeta,
      });
    } else if (traceOrMeta && typeof traceOrMeta === 'object') {
      this.logger.error(message, { context: this.context, ...traceOrMeta });
    } else {
      this.logger.error(message, { context: this.context });
    }
  }

  /**
   * Log warning level message
   */
  warn(message: any, context?: string): void;
  warn(message: any, meta?: Record<string, any>): void;
  warn(message: any, contextOrMeta?: string | Record<string, any>): void {
    if (typeof contextOrMeta === 'string') {
      this.logger.warn(message, { context: contextOrMeta || this.context });
    } else if (contextOrMeta && typeof contextOrMeta === 'object') {
      this.logger.warn(message, { context: this.context, ...contextOrMeta });
    } else {
      this.logger.warn(message, { context: this.context });
    }
  }

  /**
   * Log debug level message
   */
  debug(message: any, context?: string): void;
  debug(message: any, meta?: Record<string, any>): void;
  debug(message: any, contextOrMeta?: string | Record<string, any>): void {
    if (typeof contextOrMeta === 'string') {
      this.logger.debug(message, { context: contextOrMeta || this.context });
    } else if (contextOrMeta && typeof contextOrMeta === 'object') {
      this.logger.debug(message, { context: this.context, ...contextOrMeta });
    } else {
      this.logger.debug(message, { context: this.context });
    }
  }

  /**
   * Log verbose level message
   */
  verbose(message: any, context?: string): void {
    this.logger.verbose(message, { context: context || this.context });
  }

  /**
   * Special method for audit logs (transaction tracking)
   */
  audit(action: string, data: any, context?: string): void {
    this.logger.info({
      audit: true,
      action,
      ...data,
      context: context || this.context,
    });
  }

  /**
   * Log transaction execution details for compliance/auditing
   */
  logTransaction(params: {
    executionId: string;
    type: 'quote' | 'execute' | 'approve' | 'status';
    userWallet: string;
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount?: string;
    chainId: number | string; // Support both numeric EVM chain IDs and string chain IDs
    aggregator?: string;
    txHash?: string;
    status: 'pending' | 'success' | 'failed';
    error?: string;
    metadata?: any;
  }): void {
    this.logger.info({
      audit: true,
      transaction: true,
      timestamp: new Date().toISOString(),
      ...params,
      context: this.context,
    });
  }

  /**
   * Log API request/response for auditing
   */
  logApiCall(params: {
    method: string;
    endpoint: string;
    statusCode: number;
    duration: number;
    userWallet?: string;
    ip?: string;
    error?: string;
  }): void {
    this.logger.info({
      audit: true,
      apiCall: true,
      timestamp: new Date().toISOString(),
      ...params,
      context: 'API',
    });
  }

  /**
   * Get the underlying Winston logger instance for advanced usage
   */
  getWinstonLogger(): winston.Logger {
    return this.logger;
  }
}
