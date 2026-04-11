import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { WinstonLoggerService } from './winston-logger.service';

/**
 * Database Connection Service
 *
 * Monitors and logs database connection status for MongoDB.
 * Provides connection health information and lifecycle hooks.
 */
@Injectable()
export class DatabaseConnectionService implements OnModuleInit {
  private readonly logger: WinstonLoggerService;

  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext('DatabaseConnection');
  }

  async onModuleInit() {
    // Setup event listeners first
    this.setupMongoDBEventListeners();

    // Check if already connected (events may have fired before listeners were attached)
    if (this.mongoConnection.readyState === 1) {
      // Manually log connection success since we missed the 'connected' event
      this.logger.log('✅ MongoDB already connected', {
        host: this.mongoConnection.host,
        port: this.mongoConnection.port,
        database: this.mongoConnection.name,
        readyState: this.getReadyStateLabel(this.mongoConnection.readyState),
      });
    } else if (this.mongoConnection.readyState === 2) {
      this.logger.log('🔄 MongoDB connecting...', {
        database: this.mongoConnection.name,
        readyState: this.getReadyStateLabel(this.mongoConnection.readyState),
      });
    }
  }

  /**
   * Setup MongoDB connection event listeners
   */
  private setupMongoDBEventListeners() {
    // Connection successful
    this.mongoConnection.on('connected', () => {
      this.logger.log('✅ MongoDB connected successfully', {
        host: this.mongoConnection.host,
        port: this.mongoConnection.port,
        database: this.mongoConnection.name,
        readyState: this.getReadyStateLabel(this.mongoConnection.readyState),
      });
    });

    // Connection opened
    this.mongoConnection.on('open', () => {
      this.logger.log('📂 MongoDB connection opened', {
        database: this.mongoConnection.name,
      });
    });

    // Connection disconnected
    this.mongoConnection.on('disconnected', () => {
      this.logger.warn('⚠️ MongoDB disconnected', {
        database: this.mongoConnection.name,
      });
    });

    // Connection error
    this.mongoConnection.on('error', (error) => {
      this.logger.error('❌ MongoDB connection error', {
        error: error.message,
        stack: error.stack,
      });
    });

    // Connection reconnected
    this.mongoConnection.on('reconnected', () => {
      this.logger.log('🔄 MongoDB reconnected', {
        database: this.mongoConnection.name,
      });
    });

    // Connection close
    this.mongoConnection.on('close', () => {
      this.logger.log('🔒 MongoDB connection closed', {
        database: this.mongoConnection.name,
      });
    });
  }

  /**
   * Get MongoDB connection ready state
   */
  getConnectionStatus(): {
    isConnected: boolean;
    readyState: string;
    host: string;
    port: number;
    database: string;
  } {
    return {
      isConnected: this.mongoConnection.readyState === 1,
      readyState: this.getReadyStateLabel(this.mongoConnection.readyState),
      host: this.mongoConnection.host,
      port: this.mongoConnection.port,
      database: this.mongoConnection.name,
    };
  }

  /**
   * Convert numeric ready state to readable label
   */
  private getReadyStateLabel(state: number): string {
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
      99: 'uninitialized',
    };
    return states[state] || 'unknown';
  }

  /**
   * Check if MongoDB is connected
   */
  isMongoDBConnected(): boolean {
    return this.mongoConnection.readyState === 1;
  }
}
