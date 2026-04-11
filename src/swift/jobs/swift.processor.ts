import { Injectable, Logger } from '@nestjs/common';
import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { SwiftCheckRepository } from '@swift/repositories/swift-check.repository';
import { SwiftProviderService } from '@swift/services/provider/swift-provider.service';
import { getSwiftJobId, SwiftStatusMapper } from '@swift/utils/swift.utils';
import {
  SWIFT_APP_NAME,
  SWIFT_QUEUE_NAME,
  SWIFT_CALLBACK_QUEUE_NAME,
  SWIFT_CALLBACK_JOBS,
  SWIFT_CALLBACK_QUEUE_OPTIONS,
} from '@swift/swift.constant';
import logError, { mapCatchError } from '@shared/utils/error-logger';
import { SwiftStatus } from '@swift/types/swift.types';

export interface SwiftCheckJobData {
  swiftCheckId: string;
}

export interface SwiftCheckJobResponse {
  status: 'valid' | 'invalid';
  data?: { swiftCheckId: string };
}

@Injectable()
@Processor(SWIFT_QUEUE_NAME)
export class SwiftCheckProcessor extends WorkerHost {
  private readonly logger = new Logger(SwiftCheckProcessor.name);

  constructor(
    private readonly swiftCheckRepository: SwiftCheckRepository,
    private readonly swiftProviderService: SwiftProviderService,
    @InjectQueue(SWIFT_CALLBACK_QUEUE_NAME) private callbackQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<SwiftCheckJobData>): Promise<SwiftCheckJobResponse> {
    const { swiftCheckId } = job.data;
    this.logger.log(`Checking SWIFT transaction: ${swiftCheckId}`);

    const swiftCheck =
      await this.swiftCheckRepository.findByIdWithCompany(swiftCheckId);
    if (!swiftCheck || !swiftCheck.company) {
      throw new UnrecoverableError(`SwiftCheck ${swiftCheckId} not found`);
    }

    if (swiftCheck.status !== SwiftStatus.PENDING) {
      this.logger.warn(
        `Swift transaction ${swiftCheckId} already checked: ${swiftCheck.status}`,
      );

      return { status: 'invalid' };
    }

    const uetr = swiftCheck.payload?.uetr || null;
    if (!uetr) {
      throw new UnrecoverableError(`Missing UETR for ${swiftCheckId}`);
    }

    const providerResponse = await this.swiftProviderService.check(uetr);
    if (!providerResponse.success) {
      throw new UnrecoverableError(
        `Provider error: ${providerResponse.message}`,
      );
    }

    const rawStatus = providerResponse.data?.status ?? '';
    const mappedStatus = SwiftStatusMapper.map(rawStatus);
    const isFinalStatus = SwiftStatusMapper.isFinalStatus(mappedStatus);

    const enrichedResponse = {
      ...providerResponse.data,
      provider_status: rawStatus,
      status: mappedStatus,
      description: SwiftStatusMapper.description(mappedStatus),
      checked_at: new Date(),
    };

    const updateQuery: any = {
      $set: {
        last_checked_at: new Date(),
      },
      $push: {
        provider_response: enrichedResponse,
      },
    };

    if (isFinalStatus) {
      updateQuery.$set.status = SwiftStatus.COMPLETED;
    }

    const lastResponse = swiftCheck.provider_response?.at(-1);

    const rawStatusUnchanged = lastResponse?.provider_status === rawStatus;
    const shouldTriggerCallback = !rawStatusUnchanged || isFinalStatus;

    await this.swiftCheckRepository.update(swiftCheckId, updateQuery);

    if (shouldTriggerCallback) {
      const swiftCallbackJobId = getSwiftJobId(
        SWIFT_CALLBACK_JOBS.SEND_SWIFT_CALLBACK,
        swiftCheckId,
      );
      await this.callbackQueue.add(
        SWIFT_CALLBACK_JOBS.SEND_SWIFT_CALLBACK,
        { swiftCheckId },
        {
          ...SWIFT_CALLBACK_QUEUE_OPTIONS,
          jobId: swiftCallbackJobId,
        },
      );
      this.logger.log(
        `Callback enqueued — new status: ${mappedStatus} (UETR: ${uetr})`,
      );
    } else {
      this.logger.verbose(
        `No callback needed — status unchanged: ${mappedStatus}`,
      );
    }

    return { status: 'valid', data: { swiftCheckId } };
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job) {
    this.logger.log(`Check job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    this.logger.error(`Check job ${job.id} failed: ${err.message}`);

    await logError({
      app: SWIFT_APP_NAME,
      ...mapCatchError(err, 'SWIFT_CHECK_FAILED'),
      error_body: { jobId: job.id, jobName: job.name },
    });
  }
}
