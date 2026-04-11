// src/jobs/bullmq.processor.ts
import { Injectable, Logger } from '@nestjs/common';
import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';

import { CallbackJobData } from '@aml/types/aml';
import { AmlCheckRepository } from '@aml/repositories/aml-check.repository';
import { AmlCheckStatus } from '@aml/schemas/aml-check.schema';
import { CustomHttpService } from '@shared/services/http.service';
import {
  AmlCallbackProcessorJobName,
  AmlCallbackProcessorQueueName,
} from './constants.processor';
import { _buildNonSuccessResponse } from '@aml/utils/aml.utils';
import { generateSignature } from '@shared/utils/signature.utils';
import { AmlCheckLogRepository } from '@aml/repositories/aml-check-log.repository';
import { AmlCheckLogType } from '@aml/schemas/aml-check-log.schema';
import { safeStringify, stringLogLimit } from '@shared/utils/index.utils';
import logError, { mapCatchError } from '@shared/utils/error-logger';
import { AmlAppName, AmlError } from '@aml/enums/aml-error';

@Injectable()
@Processor(AmlCallbackProcessorQueueName)
export class AmlCallbackProcessor extends WorkerHost {
  private readonly logger = new Logger(AmlCallbackProcessor.name);

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly amlCheckRepository: AmlCheckRepository,
    private readonly amlCheckLogRepository: AmlCheckLogRepository,
  ) {
    super();
  }

  async process(job: Job) {
    this.logger.log(`Processing job: ${job.name} (ID: ${job.id})`);

    switch (job.name) {
      case AmlCallbackProcessorJobName.AmlCallback:
        return await this.handleAmlCallback(job as Job<CallbackJobData>);

      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }

  async handleAmlCallback(job: Job<CallbackJobData>) {
    const { amlCheckId, alreadyExists } = job.data;
    this.logger.log(`Processing AML callback id: ${amlCheckId}`);

    const amlCheck =
      await this.amlCheckRepository.findByIdWithCompany(amlCheckId);
    if (!amlCheck || !amlCheck.company) {
      throw new UnrecoverableError(`AML callback ${amlCheckId} not found`);
    }

    let unprocessable = false;
    if (amlCheck.status !== AmlCheckStatus.Success) {
      unprocessable = true;
      this.logger.warn(
        `Invalid provider status ${amlCheck.status} for callback ${amlCheckId}`,
      );
    } else if (!alreadyExists && amlCheck.callback_status !== 'pending') {
      unprocessable = true;
      this.logger.warn(
        `Invalid callback status ${amlCheck.callback_status} for callback ${amlCheckId}`,
      );
    } else if (!amlCheck.callback_url) {
      unprocessable = true;
      this.logger.warn(`No callback_url for callback ${amlCheckId}`);
    }

    if (unprocessable) {
      job.updateProgress(100);
      return { status: 'invalid' };
    }

    const payload = amlCheck.provider_response;

    if (typeof payload !== 'object' || Object.keys(payload).length === 0) {
      this.logger.warn(`Empty/invalid payload for callback ${amlCheckId}`);

      throw new UnrecoverableError(`Empty/invalid payload for ${amlCheckId}`);
    }

    job.updateProgress(50);

    if (
      payload.statusCode >= 400 ||
      (payload.statusCode === 200 &&
        ['error', 'failed', 'unknown'].includes(payload.risk_status))
    ) {
      throw new UnrecoverableError(`AML check failed for ${amlCheckId}`);
    }

    if (payload.uid) {
      delete payload.uid;
    }

    this.logger.debug(
      `AML callback payload: ${stringLogLimit(safeStringify(payload))}`,
    );

    if (!payload.signature) {
      payload.signature = generateSignature(payload, amlCheck.company.secret);
    }

    let response: any = null;

    try {
      const timeoutMilliseconds = 30 * 1000;
      response = await this.httpService.post(
        amlCheck.callback_url as string,
        payload,
        { timeout: timeoutMilliseconds },
      );
    } catch (error) {
      this.logger.error('handleAmlCallback error => ', error.message);

      if (response) {
        await this.amlCheckLogRepository.createLog(
          amlCheckId,
          response,
          AmlCheckLogType.Callback,
        );
      }

      throw error;
    }

    await this.amlCheckRepository.update(amlCheckId, {
      callback_status: AmlCheckStatus.Success,
    });

    await this.amlCheckLogRepository.createLog(
      amlCheckId,
      response,
      AmlCheckLogType.Callback,
    );

    this.logger.log(`AML callback ${amlCheckId} completed`);
    job.updateProgress(100);
    return { status: 'valid', data: { amlCheckId } };
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(
      `Job ${job.id} (${job.name}) completed: ${JSON.stringify(job.returnvalue)}`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} (${job.name}) failed: ${error.message}`);

    await logError({
      app: AmlAppName,
      ...mapCatchError(error, AmlError.AML_CALLBACK_FAILED),
      error_body: {
        jobId: job.id,
        jobName: job.name,
      },
    });
  }

  @OnWorkerEvent('progress')
  onProgress(job: Job<any>) {
    if (job.progress) {
      this.logger.log(`Job ${job.id} progress: ${job.progress}%`);
    }
  }
}
