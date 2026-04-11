import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AmlProviderService } from '@aml/services/provider/aml-provider.service';
import {
  _buildNonSuccessResponse,
  getAmlRiskStatus,
} from '@aml/utils/aml.utils';
import { AmlRiskStatus } from '@aml/types/aml';
import { AmlCheckDto } from '../dtos/aml-check.dto';
import { AmlCheckRepository } from '../repositories/aml-check.repository';
import { AmlCheckDocument } from '../schemas/aml-check.schema';
import { AmlHistoryDto } from '../dtos/aml-history.dto';
import { mapAmlSignals } from '@aml/utils/aml-bot-source.utils';
import { AmlCheckResponse } from './aml.service';

export interface AmlHistoryFilters {
  fromDate?: string;
  toDate?: string;
  status?: AmlRiskStatus;
  currency?: string;
  sortBy?: string;
  page?: number;
  pageSize?: number;
}

export interface AmlHistoryResponse {
  success: boolean;
  pagination: {
    page: number;
    total: number;
    pageSize: number;
    pageCount: number;
  } | null;
  data: any[];
  provider?: string;
  statusCode: number;
  message?: string;
}

/**
 * AMLHistoryService - Handles high-level AML (Anti Money Laundering) checks
 * using the third-party API calls.
 */
@Injectable()
export class AmlHistoryService {
  private readonly logger = new Logger(AmlHistoryService.name);

  constructor(
    private readonly provider: AmlProviderService,
    private readonly amlCheckRepository: AmlCheckRepository,
  ) {}

  /**
   * ✅ Get paginated AML check history with full reports (with easy filters)
   *
   * @param {AmlHistoryFilters} filters
   * @returns {Promise<AmlHistoryResponse>}
   */
  async history(
    filters: AmlHistoryDto,
    companyId: string,
  ): Promise<AmlHistoryResponse> {
    this.logger.log('Fetching paginated AML history report.');

    try {
      const { page = 1, pageSize = 15 } = filters;

      const { data: rawResponse, total } =
        await this.amlCheckRepository.findWithFilters({
          page,
          pageSize,
          companyId,
          ...filters,
        });

      return {
        success: true,
        pagination: {
          page: page,
          total: total,
          pageSize: pageSize,
          pageCount: Math.ceil(total / pageSize),
        },
        data: this.mapHistoryResponse(rawResponse),
        provider: this.provider.name,
        statusCode: HttpStatus.OK,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get paginated AML history report: ${error.message}`,
        error.stack,
      );

      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  private mapHistoryResponse(raw: AmlCheckDocument[]) {
    if (!raw || typeof raw !== 'object') {
      this.logger.warn(
        'Invalid history response from provider. Expected an object.',
      );

      return [];
    }

    return raw.map((item, _i) => this.mapHistoryItem(_i, item));
  }

  private mapHistoryItem(index: number, item: AmlCheckDocument) {
    const providerReponse = item.provider_response as AmlCheckResponse | null;
    const signals = item.provider_response?.data?.raw?.signals || {};
    const payload = item.payload as AmlCheckDto;

    return {
      id: index + 1,
      chain: payload.ticker,
      token: null,
      type: item.type,
      riskLevel: providerReponse?.score
        ? getAmlRiskStatus(providerReponse.score)
        : null,
      address: payload.address || null,
      txHash: payload.tx_hash || null,
      isToken: false,
      checkedAt: item?.createdAt.toISOString(),
      score: providerReponse?.score ? providerReponse.score : null,
      sources: mapAmlSignals(signals),
      risk_reasons: providerReponse?.data?.risk_reasons || [],
      pdf_link:
        providerReponse?.data?.pdf_link ||
        (providerReponse?.data?.raw?.pdfReport ?? null),
      _raw: providerReponse?.data?.raw || {},
    };
  }
}
