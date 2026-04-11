import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { SwiftCheckDto } from '../dtos/swift-check.dto';
import { SwiftCheckRepository } from '@swift/repositories/swift-check.repository';
import { SwiftCheck } from '@swift/schemas/swift-check.schema';
import { InjectQueue } from '@nestjs/bullmq';
import {
  SWIFT_APP_NAME,
  SWIFT_CALLBACK_QUEUE_NAME,
  SWIFT_CALLBACK_QUEUE_OPTIONS,
  SWIFT_QUEUE_OPTIONS,
  SWIFT_JOBS,
  SWIFT_QUEUE_NAME,
} from '@swift/swift.constant';
import { Queue } from 'bullmq';
import logError, { mapCatchError } from '@shared/utils/error-logger';
import { getSwiftJobId } from '@swift/utils/swift.utils';
import { SwiftStatus } from '@swift/types/swift.types';

@Injectable()
export class SwiftService {
  constructor(
    protected readonly swiftCheckRepository: SwiftCheckRepository,

    @InjectQueue(SWIFT_QUEUE_NAME)
    protected swiftQueue: Queue,

    @InjectQueue(SWIFT_CALLBACK_QUEUE_NAME)
    protected swiftCallbackQueue: Queue,
  ) {}

  async checkTransaction(payload: SwiftCheckDto, companyId: string) {
    try {
      const findAlreadyQuery: any = {
        company: companyId,
        'payload.uetr': payload.uetr,
      };

      let swiftCheck =
        await this.swiftCheckRepository.findByQuery(findAlreadyQuery);
      let swiftJobId: string | undefined = undefined;

      if (swiftCheck) {
        if (swiftCheck.status === SwiftStatus.COMPLETED) {
          swiftJobId = getSwiftJobId(
            SWIFT_JOBS.CHECK_SWIFT,
            swiftCheck._id?.toString() || '',
          );
          await this.swiftCallbackQueue.add(
            SWIFT_JOBS.CHECK_SWIFT,
            {
              swiftCheckId: swiftCheck._id?.toString(),
              payload: {
                callback_url: payload.callback_url,
                meta_data: payload.meta_data,
              },
            },
            {
              ...SWIFT_CALLBACK_QUEUE_OPTIONS,
              jobId: swiftJobId,
            },
          );
          return;
        }

        throw new HttpException(
          'Transaction already in progress.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const swiftCheckPayload: Partial<SwiftCheck> = {
        company: companyId as any,
        payload,
        callback_url: payload.callback_url,
      };

      if (payload.recheck_after) {
        swiftCheckPayload.recheck_interval_ms = payload.recheck_after * 1000;
      }

      swiftCheck = await this.swiftCheckRepository.create(swiftCheckPayload);

      if (swiftJobId === undefined) {
        swiftJobId = getSwiftJobId(
          SWIFT_JOBS.CHECK_SWIFT,
          swiftCheck._id?.toString() || '',
        );
      }

      await this.swiftQueue.add(
        SWIFT_JOBS.CHECK_SWIFT,
        { swiftCheckId: swiftCheck._id?.toString() },
        {
          ...SWIFT_QUEUE_OPTIONS,
          jobId: swiftJobId,
        },
      );
    } catch (err) {
      await logError({
        app: SWIFT_APP_NAME,
        ...mapCatchError(err),
      });

      throw new HttpException(
        err.message || 'Something went wrong. Please try again later.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
