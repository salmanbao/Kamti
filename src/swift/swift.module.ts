import { MiddlewareConsumer, Module } from '@nestjs/common';
import { SwiftController } from './swift.controller';
import { SwiftService } from './services/swift.service';
import { MongooseModule } from '@nestjs/mongoose';
import { SwiftCheck, SwiftCheckSchema } from './schemas/swift-check.schema';
import { ApiKeyAuthMiddleware } from '@core/middleware/api-key-auth.middleware';
import { SignatureValidationMiddleware } from '@core/middleware/signature-validation.middleware';
import { SwiftCheckRepository } from './repositories/swift-check.repository';
import { SwiftProviderService } from './services/provider/swift-provider.service';
import { BullModule } from '@nestjs/bullmq';
import { SWIFT_CALLBACK_QUEUE_NAME, SWIFT_QUEUE_NAME } from './swift.constant';
import { SwiftCallbackProcessor } from './jobs/swift-callback.processor';
import { SwiftCheckProcessor } from './jobs/swift.processor';
import { SwiftCronService } from './services/swift-cron.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: SwiftCheck.name,
        schema: SwiftCheckSchema,
      },
    ]),
    BullModule.registerQueue(
      { name: SWIFT_QUEUE_NAME },
      { name: SWIFT_CALLBACK_QUEUE_NAME },
    ),
  ],
  controllers: [SwiftController],
  providers: [
    SwiftService,
    SwiftCheckRepository,
    SwiftProviderService,
    SwiftCheckProcessor,
    SwiftCallbackProcessor,
    SwiftCronService,
  ],
})
export class SwiftModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ApiKeyAuthMiddleware, SignatureValidationMiddleware)
      .forRoutes(SwiftController);
  }
}
