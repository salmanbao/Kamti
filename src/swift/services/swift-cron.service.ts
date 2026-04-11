import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

import { SwiftCheckRepository } from '../repositories/swift-check.repository';
import { SwiftStatus } from '@swift/types/swift.types';
import {
  SWIFT_CALLBACK_JOBS,
  SWIFT_QUEUE_NAME,
  SWIFT_CALLBACK_QUEUE_NAME,
  SWIFT_JOBS,
  SWIFT_APP_NAME,
  SWIFT_CALLBACK_QUEUE_OPTIONS,
  SWIFT_QUEUE_OPTIONS,
} from '@swift/swift.constant';
import { getSwiftJobId } from '@swift/utils/swift.utils';
import logError, { mapCatchError } from '@shared/utils/error-logger';

@Injectable()
export class SwiftCronService {
  private readonly logger = new Logger(SwiftCronService.name);

  constructor(
    private readonly swiftCheckRepository: SwiftCheckRepository,

    @InjectQueue(SWIFT_QUEUE_NAME)
    private readonly swiftCheckQueue: Queue,

    @InjectQueue(SWIFT_CALLBACK_QUEUE_NAME)
    private readonly swiftCallbackQueue: Queue,
  ) {}

  /**
   * Runs every 30 minutes
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async schedulePendingSwiftChecks() {
    this.logger.log('Running Swift reconciliation cron');

    const now = Date.now();
    const WINDOW_MS = 30 * 60 * 1000; // 30 minutes
    const windowEnd = new Date(now + WINDOW_MS);

    try {
      const pendingChecks = await this.swiftCheckRepository.find({
        $or: [
          // 1️⃣ Normal pending checks (respect 30 min window)
          {
            status: SwiftStatus.PENDING,
            $expr: {
              $lte: [
                {
                  $add: [
                    { $ifNull: ['$last_checked_at', new Date(0)] },
                    { $ifNull: ['$recheck_interval_ms', 0] },
                  ],
                },
                windowEnd,
              ],
            },
          },
          // 2️⃣ Callback pending checks, but only if main status is COMPLETED
          {
            callback_status: SwiftStatus.PENDING,
            status: SwiftStatus.COMPLETED,
          },
        ],
      });

      for (const swiftCheck of pendingChecks) {
        if (swiftCheck.status === SwiftStatus.PENDING) {
          await this.enqueueIfNotExists(
            this.swiftCheckQueue,
            SWIFT_JOBS.CHECK_SWIFT,
            swiftCheck,
            now,
          );
        } else if (
          swiftCheck.callback_status === SwiftStatus.PENDING &&
          swiftCheck.status === SwiftStatus.COMPLETED
        ) {
          await this.enqueueIfNotExists(
            this.swiftCallbackQueue,
            SWIFT_CALLBACK_JOBS.SEND_SWIFT_CALLBACK,
            swiftCheck,
            now,
          );
        } else {
          this.logger.warn(
            `Swift check ${swiftCheck._id} has invalid status: ${swiftCheck.status}`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Error scheduling pending Swift checks', error);

      await logError({
        app: SWIFT_APP_NAME,
        ...mapCatchError(error, 'SWIFT_CRON_FAILED'),
        error_body: {},
      });
    }
  }

  /**
   * Deduplicated enqueue using jobId
   */
  private async enqueueIfNotExists(
    queue: Queue,
    jobName: string,
    swiftCheck: any,
    now: number,
  ) {
    const swiftCheckId = swiftCheck?._id?.toString() || '';
    const jobId = getSwiftJobId(jobName, swiftCheckId);

    // 1️⃣ Deduplication
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      return;
    }

    // 2️⃣ Calculate delay
    const lastCheckedAt = swiftCheck.last_checked_at
      ? swiftCheck.last_checked_at.getTime()
      : 0;

    const recheckInterval = swiftCheck.recheck_interval_ms ?? 0;
    const dontDelay =
      lastCheckedAt === 0
        ? true
        : jobName === SWIFT_CALLBACK_JOBS.SEND_SWIFT_CALLBACK;
    const nextRunAt = lastCheckedAt + recheckInterval;
    const defaultOptions =
      jobName === SWIFT_CALLBACK_JOBS.SEND_SWIFT_CALLBACK
        ? SWIFT_CALLBACK_QUEUE_OPTIONS
        : SWIFT_QUEUE_OPTIONS;
    const delay = dontDelay ? 0 : Math.max(nextRunAt - now, 0);

    await queue.add(
      jobName,
      { swiftCheckId },
      {
        ...defaultOptions,
        jobId,
        delay,
      },
    );

    this.logger.log(`Job enqueued: ${jobId}`);
  }
}
