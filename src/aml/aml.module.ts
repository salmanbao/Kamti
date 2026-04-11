import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';

// Core Middlewares
import { ApiKeyAuthMiddleware } from '@core/middleware/api-key-auth.middleware';
import { SignatureValidationMiddleware } from '@core/middleware/signature-validation.middleware';

import { AmlService } from './services/aml.service';
import { AmlSyncService } from './services/aml-sync.service';
import { AmlController } from './aml.controller';
import { AmlCheck, AmlCheckSchema } from './schemas/aml-check.schema';
import { AmlCheckRepository } from './repositories/aml-check.repository';
import { AmlProcessor } from './jobs/aml.processor';
import { AmlCallbackProcessor } from './jobs/aml-callback.processor';
import {
  AmlCallbackProcessorQueueName,
  AmlProcessorQueueName,
} from './jobs/constants.processor';
import { AmlCheckLog, AmlCheckLogSchema } from './schemas/aml-check-log.schema';
import { AmlCheckLogRepository } from './repositories/aml-check-log.repository';
import { AmlAsyncService } from './services/aml-async.service';
import { AmlHistoryService } from './services/aml-history.service';
import { AmlProviderService } from './services/provider/aml-provider.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: AmlCheck.name,
        schema: AmlCheckSchema,
      },
      {
        name: AmlCheckLog.name,
        schema: AmlCheckLogSchema,
      },
    ]),
    BullModule.registerQueue(
      { name: AmlProcessorQueueName },
      { name: AmlCallbackProcessorQueueName },
    ),
  ],
  controllers: [AmlController],
  providers: [
    AmlService,
    AmlSyncService,
    AmlAsyncService,
    AmlHistoryService,
    AmlProviderService,
    AmlProcessor,
    AmlCheckLogRepository,
    AmlCheckRepository,
    AmlCallbackProcessor,
  ],
  exports: [AmlCheckRepository, AmlCheckLogRepository],
})
export class AmlModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ApiKeyAuthMiddleware, SignatureValidationMiddleware)
      .forRoutes(AmlController);
  }
}
