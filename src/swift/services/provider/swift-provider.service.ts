import { Injectable } from '@nestjs/common';
import { CustomHttpService } from '@shared/services/http.service';

export interface SwiftCheckResponse {
  success: boolean;
  message: string;
  data: ProviderResponse;
}

export interface ProviderResponse {
  uetr: string;
  status: string | null;
  valueDate: string | null;
  lastUpdate: string | null;
  [key: string]: any;
}

@Injectable()
export class SwiftProviderService {
  private readonly BASE_URL =
    'https://corporateapi.db.com/payments/data/gpi/v1';

  constructor(private readonly httpService: CustomHttpService) {}

  private responseWrapper<T>(success = true, message = '', data?: T) {
    return {
      success,
      message,
      data,
    } as SwiftCheckResponse;
  }

  async check(uetr: string): Promise<SwiftCheckResponse> {
    const url = `${this.BASE_URL}/gpiTransactionInfo?uetr=${uetr}`;

    try {
      const response = await this.httpService.get<any>(url, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      console.log('SWIFT Check Response:', response);

      const responseData = {
        uetr: response.uetr ?? uetr,
        status: response.status ?? null,
        valueDate: response.valueDate ?? null,
        lastUpdate: response.lastUpdate ?? null,
        ...response,
      };

      return this.responseWrapper<ProviderResponse>(true, '', responseData);
    } catch (error) {
      console.error('SWIFT Check Error:', error?.message);

      return this.responseWrapper(false, error?.message);
    }
  }
}
