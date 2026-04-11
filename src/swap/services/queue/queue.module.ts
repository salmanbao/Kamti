import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullQueueAdapter } from './bull-queue.adapter';
import { WebhookService } from '../webhook/webhook.service';

/**
 * Queue Module
 *
 * Provides message queue services for async swap execution.
 * Currently uses Bull + Redis, but designed to be vendor-agnostic.
 *
 * Features:
 * - Async swap execution with job queue
 * - Job status tracking and monitoring
 * - Automatic retry with exponential backoff
 * - Redis persistence for durability
 * - Webhook notifications for job completion/failure
 *
 * Note: SwapOrchestrationService is injected by the parent SwapModule
 */
@Module({
  imports: [HttpModule],
  providers: [
    WebhookService,
    BullQueueAdapter,
    {
      provide: 'IQueueService',
      useExisting: BullQueueAdapter,
    },
  ],
  exports: [BullQueueAdapter, 'IQueueService', WebhookService],
})
export class QueueModule {}
