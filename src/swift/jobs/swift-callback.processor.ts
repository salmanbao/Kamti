import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { CustomHttpService } from '@shared/services/http.service';
import { SwiftCheckRepository } from '@swift/repositories/swift-check.repository';
import { generateSignature } from '@shared/utils/signature.utils';
import { safeStringify, stringLogLimit } from '@shared/utils/index.utils';
import {
  SWIFT_APP_NAME,
  SWIFT_CALLBACK_QUEUE_NAME,
} from '@swift/swift.constant';

import logError, { mapCatchError } from '@shared/utils/error-logger';
import { SwiftStatus } from '@swift/types/swift.types';

interface SwiftCallbackPaylod {
  callback_url: string;
  meta_data?: string;
}

export interface SwiftCallbackJobData {
  swiftCheckId: string;
  payload?: SwiftCallbackPaylod;
}

@Injectable()
@Processor(SWIFT_CALLBACK_QUEUE_NAME)
export class SwiftCallbackProcessor extends WorkerHost {
  private readonly logger = new Logger(SwiftCallbackProcessor.name);

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly swiftCheckRepository: SwiftCheckRepository,
  ) {
    super();
  }

  async process(job: Job<SwiftCallbackJobData>) {
    const { swiftCheckId, payload: jobPayload } = job.data;
    this.logger.log(`Sending SWIFT callback for: ${swiftCheckId}`);

    const swiftCheck =
      await this.swiftCheckRepository.findByIdWithCompany(swiftCheckId);
    if (!swiftCheck || !swiftCheck.company) {
      throw new UnrecoverableError(`SwiftCheck ${swiftCheckId} not found`);
    }

    if (swiftCheck.callback_status !== SwiftStatus.PENDING && !jobPayload) {
      this.logger.warn(
        `Swift transaction ${swiftCheckId} already sent to callback_url: ${swiftCheck.callback_status}`,
      );

      return { status: 'invalid' };
    }

    let callbackUrl = jobPayload?.callback_url;

    if (!callbackUrl) {
      callbackUrl = swiftCheck.callback_url ?? undefined;
    }

    if (!callbackUrl) {
      this.logger.warn(`No callback_url set for ${swiftCheckId}`);
      return { status: 'invalid' };
    }

    const requestPayload = swiftCheck.payload;
    const payload = swiftCheck.provider_response?.at(-1);
    if (!payload) {
      this.logger.error(`No provider data for ${swiftCheckId}`);

      return { status: 'invalid' };
    }

    let metaData = jobPayload?.meta_data;
    if (!metaData) {
      metaData = requestPayload.meta_data;
    }

    if (metaData) {
      payload.meta_data = requestPayload.meta_data;
    }

    if (payload.status && typeof payload.status === 'string') {
      payload.status = payload.status.toUpperCase();
    }

    if (!payload.signature) {
      payload.signature = generateSignature(payload, swiftCheck.company.secret);
    }

    this.logger.debug(
      `Callback payload: ${stringLogLimit(safeStringify(payload))}`,
    );

    let response = null;
    let updateQuery = {};

    try {
      response = await this.httpService.post(callbackUrl, payload, {
        timeout: 30_000,
      });

      this.logger.log(`Callback sent successfully for ${swiftCheckId}`);

      if (swiftCheck.status === SwiftStatus.COMPLETED) {
        updateQuery = {
          $set: {
            callback_status: SwiftStatus.COMPLETED,
          },
        };
      }

      job.updateProgress(100);
      return { status: 'valid', data: { swiftCheckId } };
    } catch (error: any) {
      this.logger.error(
        `Callback failed for ${swiftCheckId}: ${error.message}`,
      );
      throw error; // BullMQ will retry based on queue options
    } finally {
      updateQuery = {
        ...updateQuery,
        $push: {
          callback_history: {
            response,
            timestamp: new Date().toISOString(),
          },
        },
      };

      await this.swiftCheckRepository.update(swiftCheckId, updateQuery);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    this.logger.error(`Callback job ${job.id} failed: ${err.message}`);

    await logError({
      app: SWIFT_APP_NAME,
      ...mapCatchError(err, 'SWIFT_CALLBACK_SEND_FAILED'),
      error_body: { jobId: job.id, swiftCheckId: job.data.swiftCheckId },
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Callback job ${job.id} completed successfully`);
  }
}
