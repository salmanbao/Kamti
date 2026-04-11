import { Injectable, ConsoleLogger } from '@nestjs/common';
import * as winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';
import 'winston-daily-rotate-file';

@Injectable()
export class MyLogger extends ConsoleLogger {
  private readonly logger: winston.Logger;
  private readonly baseLogDir = 'logs';

  // Toggle file logging: set to false to disable file logging
  // private readonly enableFileLogging: boolean = process.env.ENABLE_FILE_LOGGING !== 'false';
  private readonly enableFileLogging: boolean = true;

  constructor() {
    super();

    const transports: winston.transport[] = [];

    if (this.enableFileLogging) {
      fs.mkdirSync(this.baseLogDir, { recursive: true });

      // Create today's directory immediately
      const today = new Date().toISOString().split('T')[0];
      const todayDir = path.join(this.baseLogDir, today);
      fs.mkdirSync(todayDir, { recursive: true });

      const createTransport = (level: string) => {
        const transport = new winston.transports.DailyRotateFile({
          // Don't use dirname - put full path logic in filename instead
          filename: path.join(this.baseLogDir, '%DATE%', `${level}-%DATE%.log`),
          datePattern: 'YYYY-MM-DD',
          level,
          zippedArchive: true,
          maxSize: '20m',
          maxFiles: '14d',
        });

        // Create directory before writing new file
        transport.on('new', (newFilename: string) => {
          const dir = path.dirname(newFilename);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        });

        // Handle rotation - ensure new date folder exists
        transport.on('rotate', (oldFilename: string, newFilename: string) => {
          const dir = path.dirname(newFilename);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        });

        transport.on('error', (err) => {
          console.error(`Winston transport error (${level}):`, err.message);
        });

        return transport;
      };

      transports.push(
        createTransport('error'),
        createTransport('info'),
        createTransport('debug'),
      );
    }

    this.logger = winston.createLogger({
      level: 'debug',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      transports,
    });

    // Handle uncaught exceptions only if file logging is enabled
    if (this.enableFileLogging && transports.length > 0) {
      this.logger.exceptions.handle(transports[0]); // error transport
    }
  }

  log(message: string, context?: string) {
    if (this.enableFileLogging) {
      this.logger.info(message, { context });
    }
    super.log(message, context);
  }

  error(message: string, trace?: string, context?: string) {
    if (this.enableFileLogging) {
      this.logger.error(message, { trace, context });
    }
    super.error(message, trace, context);
  }

  warn(message: string, context?: string) {
    if (this.enableFileLogging) {
      this.logger.warn(message, { context });
    }
    super.warn(message, context);
  }

  debug(message: string, context?: string) {
    if (this.enableFileLogging) {
      this.logger.debug(message, { context });
    }
    super.debug(message, context);
  }

  verbose(message: string, context?: string) {
    if (this.enableFileLogging) {
      this.logger.verbose(message, { context });
    }
    super.verbose(message, context);
  }
}
