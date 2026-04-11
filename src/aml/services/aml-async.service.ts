import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { _buildNonSuccessResponse } from '@aml/utils/aml.utils';
import { AmlCheckDto } from '../dtos/aml-check.dto';
import { AmlCheckRepository } from '../repositories/aml-check.repository';
import { Queue } from 'bullmq';
import {
  AmlCallbackProcessorJobName,
  AmlCallbackProcessorQueueName,
  AmlCallbackQueueOptions,
  AmlProcessorQueueName,
} from '../jobs/constants.processor';
import { InjectQueue } from '@nestjs/bullmq';
import { BaseAmlService } from './base-aml.service';
import { AmlCheckLogRepository } from '@aml/repositories/aml-check-log.repository';
import { AmlCheckResponse } from './aml.service';
import { AmlCheckDocument } from '@aml/schemas/aml-check.schema';

/**
 * AMLAsyncService - Handles high-level AML (Anti Money Laundering) checks
 * using the third-party API calls.
 */
@Injectable()
export class AmlAsyncService extends BaseAmlService {
  protected readonly logger = new Logger(AmlAsyncService.name);

  constructor(
    protected readonly amlCheckRepository: AmlCheckRepository,
    protected readonly amlCheckLogRepository: AmlCheckLogRepository,
    @InjectQueue(AmlProcessorQueueName) protected amlQueue: Queue,
    @InjectQueue(AmlCallbackProcessorQueueName) private amlCallbackQueue: Queue,
  ) {
    super(amlCheckRepository, amlCheckLogRepository, amlQueue);
  }

  /**
   * Check wallet address or transaction hash for AML risk asynchronously.
   *
   * @param {AmlCheckDto} payload
   *
   * @returns {Promise<AmlCheckResponse>}
   */
  async check(
    payload: AmlCheckDto,
    companyId: string,
  ): Promise<AmlCheckResponse> {
    this.logger.log(`Starting AML async check for type: ${payload.type}`);

    try {
      let alreadyExists = true;
      let amlCheck: AmlCheckDocument | null = null;

      if (payload.type === 'address') {
        amlCheck = await this.getExistingAmlCheck(payload, companyId);
      }

      // If not exists then create
      if (!amlCheck) {
        alreadyExists = false;
        amlCheck = await this.createAmlCheckRecord(payload, companyId);
      }

      const queueData = {
        amlCheckId: amlCheck?._id?.toString(),
      };

      if (alreadyExists) {
        await this.amlCallbackQueue.add(
          AmlCallbackProcessorJobName.AmlCallback,
          {
            ...queueData,
            alreadyExists,
          },
          AmlCallbackQueueOptions,
        );
      } else {
        await this.addAmlCheckIntoQueue(queueData);
      }

      return _buildNonSuccessResponse(
        true,
        'pending',
        'AML check started',
        HttpStatus.ACCEPTED,
      );
    } catch (error) {
      this.logger.error(`AML check failed: ${error.message}`, error.stack);
      return _buildNonSuccessResponse(false, 'error', error.message);
    }
  }
}
