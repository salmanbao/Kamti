import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  HttpException,
  Get,
  Res,
  Inject,
} from '@nestjs/common';
import { AmlCheckResponse, AmlService } from './services/aml.service';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  refs,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { AmlCheckDto } from './dtos/aml-check.dto';
import { AmlHistoryDto } from './dtos/aml-history.dto';
import {
  AmlCheckSuccessAddressResponseDto,
  AmlCheckSuccessTransactionResponseDto,
  AmlCheckPendingResponseDto,
  AmlCheckErrorResponseDto,
} from './dtos/aml-responses.dto';
import {
  BadRequestErrorResponseDto,
  ErrorResponseDto,
  InternalServerErrorResponseDto,
} from '@shared/dtos/error-exception.dto';
import { RequestCompany } from '@shared/decorators/request-company.decorator';
import type { CompanyDocument } from '@shared/company/schemas/company.schema';
import { AmlHistoryPaginatedResponseDto } from './dtos/aml-history-responses.dto';
import { AmlSyncService } from './services/aml-sync.service';
import { AmlAsyncService } from './services/aml-async.service';
import { AmlHistoryService } from './services/aml-history.service';
import type { Response } from 'express';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';

@ApiTags('AML')
@Controller('aml')
@ApiExtraModels(
  AmlCheckSuccessAddressResponseDto,
  AmlCheckSuccessTransactionResponseDto,
  AmlCheckPendingResponseDto,
  BadRequestErrorResponseDto,
  InternalServerErrorResponseDto,
  AmlHistoryPaginatedResponseDto,
)
export class AmlController {
  constructor(
    private readonly amlSyncService: AmlSyncService,
    private readonly amlAsyncService: AmlAsyncService,
    private readonly amlHistoryService: AmlHistoryService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  @Post('check')
  @ApiOperation({
    summary: 'Perform AML Check',
    description:
      'Initiates an Anti-Money Laundering (AML) check on a specified cryptocurrency address or transaction. The endpoint supports both synchronous (`sync`) and asynchronous (`async`) responses. ' +
      'In `sync` mode, it provides an immediate risk assessment. If the assessment is inconclusive and a `callback_url` is provided, it transitions to an `async` flow. ' +
      'In `async` mode, the system acknowledges the request and delivers the results to the specified `callback_url` upon completion.',
  })
  @ApiBody({ type: AmlCheckDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'The AML check has been successfully processed. The response will vary based on the `type` of the check.',
    schema: {
      anyOf: refs(
        AmlCheckSuccessAddressResponseDto,
        AmlCheckSuccessTransactionResponseDto,
      ),
    },
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description:
      'The AML check has been accepted and is pending. This status is returned for `async` requests or `sync` requests that require more time to process.',
    schema: {
      $ref: getSchemaPath(AmlCheckPendingResponseDto),
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'The request is invalid. This could be due to missing required fields, malformed data, or other client-side errors.',
    schema: {
      $ref: getSchemaPath(BadRequestErrorResponseDto),
    },
  })
  async amlCheck(
    @Body() payload: AmlCheckDto,
    @RequestCompany() company: CompanyDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<any> {
    let amlResponse: AmlCheckResponse | undefined = undefined;
    const companyId = company?._id?.toString() || '';
    const amlEnv =
      (await this.cacheManager.get('aml-environment')) || 'production';

    if (payload.response_type === 'sync') {
      amlResponse = await this.amlSyncService.check(payload, companyId);
    }

    if (payload.response_type === 'async') {
      amlResponse = await this.amlAsyncService.check(payload, companyId);
    }

    if (amlResponse === undefined) {
      throw new HttpException('AML check failed', HttpStatus.BAD_REQUEST);
    }

    if (
      amlResponse.statusCode >= 400 ||
      (amlResponse.statusCode === 200 &&
        ['error', 'failed', 'unknown'].includes(amlResponse.risk_status))
    ) {
      throw new HttpException(
        amlResponse.message || 'Something went wrong!',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (amlResponse.uid) {
      delete amlResponse.uid;
    }

    res.status(amlResponse.statusCode);
    return amlResponse;
  }

  @Post('history')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get AML Check History',
    description:
      'Retrieves a paginated history of Anti-Money Laundering (AML) checks. This endpoint allows for filtering and sorting of the results based on various criteria.',
  })
  @ApiBody({ type: AmlHistoryDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The AML check history has been successfully retrieved.',
    schema: {
      $ref: getSchemaPath(AmlHistoryPaginatedResponseDto),
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'The request is invalid. This could be due to missing required fields, malformed data, or other client-side errors.',
    schema: {
      $ref: getSchemaPath(BadRequestErrorResponseDto),
    },
  })
  async historyReport(
    @Body() filters: AmlHistoryDto,
    @RequestCompany() company: CompanyDocument,
  ) {
    return await this.amlHistoryService.history(
      filters,
      company?._id?.toString() || '',
    );
  }
}
