import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CoreModule } from './core/core.module';
import { SharedModule } from './shared/shared.module';
import { SwapModule } from './swap/swap.module';
import appConfig, {
  validateEnvironmentVariables,
} from './shared/config/env.config';
import { AmlModule } from './aml/aml.module';
import { CacheModule } from '@nestjs/cache-manager';
import { LoggerModule } from './logger/logger.module';
import { SwiftModule } from './swift/swift.module';

/**
 * Application Root Module
 *
 * Main entry point for the NestJS application. Imports and configures
 * all feature modules and global modules.
 *
 * Module Structure:
 * - CoreModule: Global filters, interceptors, pipes, and guards
 * - SharedModule: Shared utilities and services (HTTP, logging, config)
 * - SwapModule: Swap aggregator functionality
 *
 * Configuration:
 * - Environment variables loaded from .env file
 * - Global configuration module for app-wide access
 */
@Module({
  imports: [
    CacheModule.register({ isGlobal: true }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig],
      cache: true,
      validate: validateEnvironmentVariables, // Validate environment variables at startup
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: parseInt(configService.get('REDIS_PORT', '6379')),
          password: configService.get('REDIS_PASSWORD', ''),
        },
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    CoreModule,
    SharedModule,
    SwapModule,
    AmlModule,
    LoggerModule,
    SwiftModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
