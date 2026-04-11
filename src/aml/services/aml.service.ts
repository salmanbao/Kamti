import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AmlProviderService,
  TransactionDirection,
} from '@aml/services/provider/aml-provider.service';
import * as crypto from 'crypto';
import {
  _buildNonSuccessResponse,
  getAmlRiskStatus,
  getAmlSuccess,
} from '@aml/utils/aml.utils';
import { AmlBotResponseStatus } from '@aml/types/provider/aml-bot';
import {
  AmlAddressReportData,
  type AmlCheckType,
  AmlResponseBaseData,
  AmlRiskStatus,
  AmlRiskStatusError,
  AmlTransactionReportData,
} from '@aml/types/aml';
import { AmlCheckDto } from '../dtos/aml-check.dto';
import { AmlCheckRepository } from '../repositories/aml-check.repository';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  classifyAmlScores,
  generateRandomAmlSignals,
} from '@aml/utils/aml-bot-source.utils';
import logError, { mapCatchError } from '@shared/utils/error-logger';
import { AmlAppName, AmlError } from '@aml/enums/aml-error';
import { safeStringify } from '@shared/utils/index.utils';

export interface AmlCheckResponse {
  success: boolean;
  score: number | null;
  risk_status: AmlRiskStatus | AmlRiskStatusError;
  data: AmlAddressReportData | AmlTransactionReportData | null;
  provider?: string;
  statusCode: number;
  message?: string;
  uid?: string;
  meta_data?: string;
}

/**
 * AMLService - Handles high-level AML (Anti Money Laundering) checks
 * using the third-party API calls.
 */
@Injectable()
export class AmlService {
  private readonly logger = new Logger(AmlService.name);

  constructor(
    private readonly provider: AmlProviderService,
    private readonly amlCheckRepository: AmlCheckRepository,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async checkAml(payload: AmlCheckDto): Promise<AmlCheckResponse> {
    this.logger.log(`Starting AML sync check for type: ${payload.type}`);
    try {
      const report = await this._getAmlReport(payload.type, payload);

      const status = getAmlRiskStatus(report?.risk_score ?? null);
      this.logger.log(`AML check completed with status: ${status}`);

      return this._buildReportResponse(
        report,
        this.provider.name,
        payload.meta_data,
      );
    } catch (error) {
      const errorResponse = _buildNonSuccessResponse(
        false,
        'error',
        error.message,
      );

      const errorLog = await logError({
        app: AmlAppName,
        ...mapCatchError(error),
        error_body: errorResponse,
      });

      this.logger.error(`AML check failed: ${safeStringify(errorLog)}`);

      return errorResponse;
    }
  }

  async recheckAml(uid: string): Promise<AmlCheckResponse> {
    this.logger.log(`Starting AML sync check for uid: ${uid}`);
    try {
      const checkAml = await this.amlCheckRepository.findByUid(uid);
      if (!checkAml) {
        throw new Error('AML check not found. UID: ' + uid);
      }
      const { type, payload } = checkAml;
      if (!payload) {
        throw new Error('AML check payload not found. UID: ' + uid);
      }

      const requestPayload = payload as AmlCheckDto;

      this.logger.log(`payload: ${JSON.stringify(requestPayload)}`);
      const report = await this._getAmlReport(type, requestPayload, uid);

      const status = getAmlRiskStatus(report?.risk_score ?? null);
      this.logger.log(`AML check completed with status: ${status}`);

      return this._buildReportResponse(
        report,
        this.provider.name,
        requestPayload.meta_data,
      );
    } catch (error) {
      const errorResponse = _buildNonSuccessResponse(
        false,
        'error',
        error.message,
      );

      const errorLog = await logError({
        app: AmlAppName,
        ...mapCatchError(error),
        error_body: errorResponse,
      });

      this.logger.error(`AML re-check failed: ${safeStringify(errorLog)}`);

      return errorResponse;
    }
  }

  private async _getAmlReport(
    type: AmlCheckType,
    payload: AmlCheckDto,
    uid?: string,
  ): Promise<AmlResponseBaseData> {
    // Checking if ticker is valid
    // if (payload.ticker) {
    //     this.provider.getAsset(payload.ticker);
    // }

    if (payload?.isFake === 'true') {
      this.logger.log('AML provider is disabled. Returning simulated data.');
      return await this._generateSimulatedReport(type, payload, uid);
    } else {
      this.logger.log(
        `Calling AML provider for ${type} ${uid ? 'recheck' : 'check'}.`,
      );
      if (uid) {
        // Recheck via polling
        return await this.provider.pollRecheck(type, 'sdflasdf');
      } else {
        // New check
        if (type === 'address') {
          return await this.provider.checkAddressReport({
            ticker: payload.ticker,
            address: payload.address,
            token: payload.token,
          });
        } else {
          return await this.provider.checkTransactionReport({
            ticker: payload.ticker,
            tx_hash: payload.tx_hash as string,
            token: payload.token,
            address: payload.address,
            direction: payload.direction || 'deposit',
          });
        }
      }
    }
  }

  private async _generateSimulatedReport(
    type: 'address' | 'transaction',
    payload: AmlCheckDto,
    uid?: string,
  ): Promise<AmlResponseBaseData> {
    // const risk_score = Math.floor(Math.random() * 90) + 5; // Vary 5-95
    const risk_score = parseInt(
      (await this.cacheManager.get('aml-score')) || '90',
    );
    const modifiedSignals = classifyAmlScores(generateRandomAmlSignals());
    const counterparty = {
      in: {
        amount: Math.floor(Math.random() * 90) + 5,
        reasons: modifiedSignals,
      },
      out: {
        amount: Math.floor(Math.random() * 90) + 5,
        reasons: modifiedSignals,
      },
    };
    const pdfLink =
      'https://extrnlapiendpoint.silencatech.com/response/userdata/284325A967F0B50/renderer/pdf/responsedata/69299E8CE5EA2661163127:4B5A927CC1DFDD2';

    let data: AmlAddressReportData | AmlTransactionReportData;
    if (type === 'address') {
      data = {
        type: 'address',
        ticker: payload.ticker,
        address: payload.address,
        balance: Math.floor(Math.random() * 90) + 5,
        balance_usd: Math.floor(Math.random() * 90) + 5,
        risk_reasons: modifiedSignals,
        address_connections: modifiedSignals,
        counterparty_connections: counterparty,
        pdf_link: pdfLink,
        raw: {},
      };
    } else {
      data = {
        type: 'transaction',
        tx_hash: payload.tx_hash as string,
        ticker: payload.ticker,
        from: payload.direction === 'withdrawal' ? payload.address : null,
        to: payload.direction === 'deposit' ? payload.address : null,
        amount: Math.floor(Math.random() * 90) + 5,
        fiat_amount: Math.floor(Math.random() * 90) + 5,
        created_at: new Date().toISOString(),
        risk_reasons: modifiedSignals,
        counterparty_connections: counterparty,
        pdf_link: '',
        raw: {},
      };
    }
    return {
      risk_score,
      status: 'success' as AmlBotResponseStatus,
      uid: uid ?? crypto.randomUUID(),
      data,
    };
  }

  private _buildReportResponse(
    report: AmlResponseBaseData,
    providerName: string,
    meta_data?: string,
  ): AmlCheckResponse {
    const score = report?.risk_score ?? null;
    const check_status = (report?.status ?? 'error') as AmlBotResponseStatus;
    const status = getAmlRiskStatus(score);
    const isSuccess = check_status === 'success';
    return {
      success: isSuccess ? getAmlSuccess(status) : false,
      score: isSuccess ? score : null,
      risk_status: isSuccess ? status : (check_status as AmlRiskStatusError),
      provider: providerName,
      data: report?.data || {},
      statusCode: HttpStatus.OK,
      message: isSuccess
        ? 'AML check completed'
        : 'AML check status: ' + check_status + '.',
      uid: report?.uid ?? null,
      meta_data,
    };
  }
}
