import { Injectable, Logger } from '@nestjs/common';
import { CustomHttpService } from './http.service';
import { ConfigService } from '@nestjs/config';

export type ClearCheckSearchParams = {
  where?: Array<{ [key: string]: string | number }>;
  sortBy?: string;
  page?: number;
  pageSize?: number;
};

export type ClearCheckTransactionReportParams = {
  ticker: string;
  tx_hash: string;
  token?: string;
};

export type ClearCheckAddressReportParams = {
  ticker: string;
  address: string;
  token?: string;
};

// Define more specific response types if the API schema is known
export type TransactionReportResponse = any;
export type AddressReportResponse = any;
export type HistoryReportResponse = any;
export type ShortHistoryReportResponse = any;

@Injectable()
export class ClearCheckService {
  private readonly logger = new Logger(ClearCheckService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  public readonly name = 'ClearCheck';

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>('AML_PROVIDER_URL') ?? '';
    this.apiKey = this.configService.get<string>('AML_PROVIDER_API_KEY') ?? '';

    if (!this.baseUrl) {
      throw new Error('[ClearCheckService] Missing base URL');
    }

    if (!this.apiKey) {
      throw new Error('[ClearCheckService] Missing API key');
    }

    if (this.baseUrl.endsWith('/')) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
  }

  private async request<P, R>(
    endpoint: string,
    method: 'GET' | 'POST',
    params?: P,
  ): Promise<R> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': this.apiKey,
    };

    try {
      if (method === 'GET') {
        const queryString = params
          ? new URLSearchParams(params as any).toString()
          : '';
        const fullUrl = queryString ? `${url}?${queryString}` : url;
        console.log('fullUrl', fullUrl);
        return await this.httpService.get<R>(fullUrl, { headers });
      } else {
        return await this.httpService.post<R>(url, params, { headers });
      }
    } catch (error) {
      this.logger.error(
        `Request to ClearCheck failed at endpoint ${endpoint}: ${error.message}`,
        error.stack,
      );
      throw error; // Re-throw the error from CustomHttpService
    }
  }

  async checkTransactionReport(
    params: ClearCheckTransactionReportParams,
  ): Promise<TransactionReportResponse> {
    this.validateParams(params, ['ticker', 'tx_hash']);
    return this.request<
      ClearCheckTransactionReportParams,
      TransactionReportResponse
    >('/v1/transaction_report', 'GET', params);
  }

  async checkAddressReport(
    params: ClearCheckAddressReportParams,
  ): Promise<AddressReportResponse> {
    this.validateParams(params, ['ticker', 'address']);
    return this.request<ClearCheckAddressReportParams, AddressReportResponse>(
      '/v1/address_report',
      'GET',
      params,
    );
  }

  async getPaginatedHistoryReport(
    searchParams: ClearCheckSearchParams,
  ): Promise<HistoryReportResponse> {
    const { where, sortBy, page = 1, pageSize = 10 } = searchParams;

    if (where && !Array.isArray(where)) {
      throw new Error(
        "[ClearCheckService] 'where' must be an array of filter objects.",
      );
    }

    if (page <= 0 || pageSize <= 0) {
      throw new Error(
        "[ClearCheckService] 'page' and 'pageSize' must be positive numbers.",
      );
    }

    const queryParams: {
      page: number;
      pageSize: number;
      where?: string;
      sortBy?: string;
    } = { page, pageSize };

    if (where) {
      queryParams.where = JSON.stringify(where);
    }
    if (sortBy) {
      queryParams.sortBy = sortBy;
    }

    return this.request<typeof queryParams, HistoryReportResponse>(
      '/v1/history/full-report',
      'GET',
      queryParams,
    );
  }

  async getPaginatedShortHistoryReport(
    searchParams: ClearCheckSearchParams,
  ): Promise<ShortHistoryReportResponse> {
    const { where, sortBy, page = 1, pageSize = 10 } = searchParams;

    if (where && !Array.isArray(where)) {
      throw new Error(
        "[ClearCheckService] 'where' must be an array of filter objects.",
      );
    }

    if (page <= 0 || pageSize <= 0) {
      throw new Error(
        "[ClearCheckService] 'page' and 'pageSize' must be positive numbers.",
      );
    }

    const queryParams: {
      page: number;
      pageSize: number;
      where?: string;
      sortBy?: string;
    } = { page, pageSize };

    if (where) {
      queryParams.where = JSON.stringify(where);
    }
    if (sortBy) {
      queryParams.sortBy = sortBy;
    }

    return this.request<typeof queryParams, ShortHistoryReportResponse>(
      '/v1/history/short-report',
      'GET',
      queryParams,
    );
  }

  private validateParams<T>(payload: T, requiredFields: (keyof T)[]): void {
    const missing = requiredFields.filter((f) => !payload[f]);
    if (missing.length > 0) {
      throw new Error(
        `[ClearCheckService] Missing required parameters: ${missing.join(
          ', ',
        )}`,
      );
    }
  }
}
