// src/jobs/bullmq.processor.ts
import { ModuleRef } from '@nestjs/core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Processor,
  OnWorkerEvent,
  WorkerHost,
  InjectQueue,
} from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';

import { CheckJobData } from '@aml/types/aml';
import { AmlCheckResponse, AmlService } from '@aml/services/aml.service';
import { AmlCheckRepository } from '@aml/repositories/aml-check.repository';
import { AmlCheckDto } from '@aml/dtos/aml-check.dto';
import { AmlCheckStatus } from '@aml/schemas/aml-check.schema';
import { isFinalAmlStatus } from '@aml/utils/aml.utils';
import {
  AmlCallbackProcessorJobName,
  AmlCallbackProcessorQueueName,
  AmlCallbackQueueOptions,
  AmlProcessorJobName,
  AmlProcessorQueueName,
} from './constants.processor';
import { RetryPendingException } from '@aml/exceptions/retry-pending-exception.exception';
import { AmlCheckLogRepository } from '@aml/repositories/aml-check-log.repository';
import logError, { mapCatchError } from '@shared/utils/error-logger';
import { AmlAppName, AmlError } from '@aml/enums/aml-error';

interface AmlCheckJobResponse {
  status: string;
  data?: {
    amlCheckId: string;
  };
}

@Injectable()
@Processor(AmlProcessorQueueName)
export class AmlProcessor extends WorkerHost {
  private readonly logger = new Logger(AmlProcessor.name);

  constructor(
    private readonly amlService: AmlService,
    private readonly amlCheckRepository: AmlCheckRepository,
    private readonly amlCheckLogRepository: AmlCheckLogRepository,
    @InjectQueue(AmlCallbackProcessorQueueName) private amlCallbackQueue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    this.logger.log(`Processing job: ${job.name} (ID: ${job.id})`);

    switch (job.name) {
      case AmlProcessorJobName.CheckAml:
        return await this.handleCheckAml(job as Job<CheckJobData>);

      default:
        this.logger.error(`Unknown job name: ${job.name}`);
    }
  }

  async handleCheckAml(job: Job<CheckJobData>) {
    const { amlCheckId } = job.data;
    this.logger.log(`Processing aml check id: ${amlCheckId}`);

    const amlCheck = await this.amlCheckRepository.findById(amlCheckId);
    if (!amlCheck) {
      throw new UnrecoverableError(`AML check ${amlCheckId} not found`);
    }

    if (amlCheck.status !== AmlCheckStatus.Pending) {
      throw new UnrecoverableError(`Invalid status for ${amlCheckId}`);
    }

    let response: AmlCheckResponse | undefined = undefined;
    try {
      if (amlCheck.uid) {
        response = await this.amlService.recheckAml(amlCheck.uid);
      } else {
        response = await this.amlService.checkAml(
          amlCheck.payload as AmlCheckDto,
        );
        if (response.risk_status === 'pending') {
          await this.amlCheckRepository.update(amlCheckId, {
            uid: response.uid,
          });

          await this.amlCheckLogRepository.createLog(amlCheckId, response);

          throw new RetryPendingException('Pending - retrying');
        }
      }
    } catch (error) {
      this.logger.error(`AML check ${amlCheckId} error: ${error.message}`);

      if (!(error instanceof RetryPendingException) && response) {
        await this.amlCheckLogRepository.createLog(amlCheckId, response);
      }

      throw error;
    }

    job.updateProgress(100);
    const newStatus = isFinalAmlStatus(response.risk_status)
      ? AmlCheckStatus.Success
      : AmlCheckStatus.Pending;

    await this.amlCheckRepository.update(amlCheckId, {
      status: newStatus,
      uid: response.uid,
      provider_response: response,
    });

    await this.amlCheckLogRepository.createLog(amlCheckId, response);

    return {
      status: isFinalAmlStatus(response.risk_status) ? 'valid' : 'invalid',
      data: { amlCheckId },
    };
  }

  async handleCallback(response: AmlCheckJobResponse) {
    this.logger.log(`Processing callback: ${JSON.stringify(response)}`);

    await this.amlCallbackQueue.add(
      AmlCallbackProcessorJobName.AmlCallback,
      { amlCheckId: response.data?.amlCheckId },
      AmlCallbackQueueOptions,
    );
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job) {
    this.logger.log(
      `Job ${job.id} (${job.name}) completed: ${JSON.stringify(job.returnvalue)}`,
    );

    switch (job.name) {
      case AmlProcessorJobName.CheckAml:
        await this.handleCallback(job.returnvalue as AmlCheckJobResponse);
        break;

      default:
        this.logger.error(`Unknown job name: ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} (${job.name}) failed: ${error.message}`);

    await logError({
      app: AmlAppName,
      ...mapCatchError(error, AmlError.AML_PROCESSING_FAILED),
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
