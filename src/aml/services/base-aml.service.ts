import { Logger } from '@nestjs/common';
import { AmlCheckRepository } from '../repositories/aml-check.repository';
import { AmlCheckLogRepository } from '../repositories/aml-check-log.repository';
import { AmlCheckDto } from '../dtos/aml-check.dto';
import {
  AmlCheckDocument,
  AmlCheck,
  AmlCheckType,
} from '../schemas/aml-check.schema';
import { Queue } from 'bullmq';
import { safeStringify } from '@shared/utils/index.utils';
import { AmlProcessorJobName } from '../jobs/constants.processor';

export abstract class BaseAmlService {
  protected readonly logger: Logger;

  constructor(
    protected readonly amlCheckRepository: AmlCheckRepository,
    protected readonly amlCheckLogRepository: AmlCheckLogRepository,
    protected readonly amlQueue: Queue,
  ) {
    // Dynamically binds logger to child class name
    this.logger = new Logger(this.constructor.name);
  }

  protected async getExistingAmlCheck(
    payload: AmlCheckDto,
    companyId: string,
  ): Promise<AmlCheckDocument | null> {
    const isSandbox = Boolean(payload?.isFake === 'true');

    const query: any = {
      type: payload.type as AmlCheckType,
      company: companyId,
      'payload.address': payload.address,
      'payload.isFake': isSandbox ? 'true' : 'false',
      'provider_response.risk_status': 'high',
    };

    const amlCheck = await this.amlCheckRepository.findByQuery(query);

    if (!amlCheck) {
      this.logger.warn(
        `No existing AML check found for address ${payload.address}`,
      );

      return null;
    }

    this.logger.log(`Found existing AML check: ${amlCheck._id}`);

    const canReuse =
      amlCheck.provider_response &&
      amlCheck.provider_response?.risk_status === 'high' &&
      amlCheck.type === 'address';

    return canReuse ? amlCheck : null;
  }

  protected async createAmlCheckRecord(
    payload: AmlCheckDto,
    companyId: string,
    uid: string | null = null,
  ): Promise<AmlCheckDocument | null> {
    try {
      const createData: Partial<AmlCheck> = {
        type: payload.type as any,
        callback_url: payload.callback_url || null,
        response_type: payload.response_type,
        uid: uid || null,
        payload,
        company: companyId as any,
      };

      return await this.amlCheckRepository.create(createData);
    } catch (err) {
      this.logger.error(`Failed creating AML check: ${err.message}`);
      return null;
    }
  }

  protected async addAmlCheckIntoQueue(
    data: any,
    options?: any,
  ): Promise<void> {
    const retryOnFailAfter = 1 * 60 * 1000; // 1 minute
    const delay = options?.delay ?? 1000;

    const queueOptions = {
      backoff: { type: 'exponential', delay: retryOnFailAfter },
      delay,
      attempts: 3,
      removeOnComplete: true,
    };

    this.logger.log('Adding AML check to queue: ' + safeStringify(data));

    await this.amlQueue.add(AmlProcessorJobName.CheckAml, data, queueOptions);
  }
}
