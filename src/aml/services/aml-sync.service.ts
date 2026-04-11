import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  _buildNonSuccessResponse,
  isFinalAmlStatus,
} from '@aml/utils/aml.utils';
import { AmlCheckDto } from '../dtos/aml-check.dto';
import { AmlCheckRepository } from '../repositories/aml-check.repository';
import { Queue } from 'bullmq';
import { AmlCheckDocument, AmlCheckStatus } from '../schemas/aml-check.schema';
import { AmlProcessorQueueName } from '../jobs/constants.processor';
import { InjectQueue } from '@nestjs/bullmq';
import { AmlCheckLogRepository } from '../repositories/aml-check-log.repository';
import { AmlCheckResponse, AmlService } from './aml.service';
import { BaseAmlService } from './base-aml.service';

/**
 * AMLSyncService - Handles high-level AML (Anti Money Laundering) checks
 * using the third-party API calls.
 */
@Injectable()
export class AmlSyncService extends BaseAmlService {
  protected readonly logger = new Logger(AmlSyncService.name);

  constructor(
    protected readonly amlService: AmlService,
    protected readonly amlCheckRepository: AmlCheckRepository,
    protected readonly amlCheckLogRepository: AmlCheckLogRepository,
    @InjectQueue(AmlProcessorQueueName) protected amlQueue: Queue,
  ) {
    super(amlCheckRepository, amlCheckLogRepository, amlQueue);
  }

  /**
   * Check wallet address or transaction hash for AML risk synchronously.
   *
   * @param {AmlCheckDto} payload
   *
   * @returns {Promise<AmlCheckResponse>}
   */
  async check(
    payload: AmlCheckDto,
    companyId: string,
  ): Promise<AmlCheckResponse> {
    this.logger.log(`Starting AML sync check for type: ${payload.type}`);

    try {
      let amlCheck: AmlCheckDocument | null = null,
        pending = false;

      if (payload.type === 'address') {
        amlCheck = await this.getExistingAmlCheck(payload, companyId);
      }

      if (!amlCheck) {
        const amlResponse = await this.amlService.checkAml(payload);
        amlCheck = await this.createAmlCheckRecord(
          payload,
          companyId,
          amlResponse.uid,
        );
        const amlCheckId = amlCheck?._id?.toString();

        const amlUpdateData: Record<string, any> = {
          callback_status: AmlCheckStatus.Success,
        };

        if (isFinalAmlStatus(amlResponse.risk_status)) {
          amlUpdateData.provider_response = amlResponse;
        }

        await this.amlCheckLogRepository.createLog(
          amlCheckId ?? '',
          amlResponse,
        );

        if (
          amlResponse !== undefined &&
          amlResponse.risk_status === 'pending'
        ) {
          pending = true;
          this.logger.log(
            `AML check ${amlResponse.uid} is pending. Adding to queue.`,
          );

          const delay = 5 * 60 * 1000; // 5 minute
          await this.addAmlCheckIntoQueue(
            {
              amlCheckId: amlCheckId,
            },
            { delay },
          );
        } else {
          amlUpdateData.status = AmlCheckStatus.Success;
        }

        await this.amlCheckRepository.update(
          amlCheckId as string,
          amlUpdateData,
        );

        if (pending) {
          return _buildNonSuccessResponse(
            true,
            'pending',
            'AML check started',
            HttpStatus.ACCEPTED,
          );
        }

        return amlResponse;
      }

      return amlCheck.provider_response as AmlCheckResponse;
    } catch (error) {
      this.logger.error(`AML check failed: ${error.message}`, error.stack);

      return _buildNonSuccessResponse(false, 'error', error.message);
    }
  }
}
