import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

export enum AmlRiskStatusSuccess {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export enum AmlRiskStatusPending {
  Pending = 'pending',
}

export enum AmlRiskStatusError {
  Error = 'error',
  Failed = 'failed',
  Unknown = 'unknown',
}

export class RiskReasonItem {
  @ApiProperty({ example: 'merchant_services' })
  key: string;

  @ApiProperty({ example: 31 })
  score: number;

  @ApiProperty({
    example: 'Payment processors enabling crypto payments for businesses.',
  })
  description: string;
}

export class RiskReasonGroup {
  @ApiProperty({ type: [RiskReasonItem] })
  low: RiskReasonItem[];

  @ApiProperty({ type: [RiskReasonItem] })
  medium: RiskReasonItem[];

  @ApiProperty({ type: [RiskReasonItem] })
  high: RiskReasonItem[];

  @ApiProperty({ type: [RiskReasonItem] })
  additional: RiskReasonItem[];
}

// --- Base Report DTOs ---
export class AmlAddressReportDto {
  @ApiProperty({ example: 'address', description: 'The type of the report.' })
  type: 'address';

  @ApiProperty({
    example: 'btc',
    description: 'The ticker symbol of the cryptocurrency.',
  })
  ticker: string;

  @ApiProperty({
    example: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    description: 'The address that was checked.',
  })
  address: string;

  @ApiProperty({
    example: 0.001,
    description: 'The amount of the transaction in the currency.',
  })
  balace: number;

  @ApiProperty({
    example: 1,
    description: 'The amount of the transaction in the usd.',
  })
  balace_usd: number;

  @ApiProperty({
    type: RiskReasonGroup,
    description: 'Detailed breakdown of AML risk reasons grouped by severity.',
  })
  risk_reasons: RiskReasonGroup;

  @ApiProperty({
    type: RiskReasonGroup,
    description: 'Detailed breakdown of AML risk reasons grouped by severity.',
  })
  address_connections: RiskReasonGroup;

  @ApiProperty({
    type: Object,
    example: {},
    description: "Aml Provider's raw response data.",
  })
  raw: {};
}

export class AmlTransactionReportDto {
  @ApiProperty({
    example: 'transaction',
    description: 'The type of the report.',
  })
  type: 'transaction';

  @ApiProperty({
    example: 'eth',
    description: 'The ticker symbol of the cryptocurrency.',
  })
  ticker: string;

  @ApiProperty({
    example: '0x123abc...def456',
    description: 'The transaction hash that was checked.',
  })
  tx_hash: string;

  @ApiProperty({
    example: '2023-10-27T10:00:00Z',
    description: 'The timestamp of the transaction.',
  })
  created_at: string;

  @ApiPropertyOptional({
    example: '0xfrom...address',
    description: 'The sender address.',
  })
  from?: string | null;

  @ApiPropertyOptional({
    example: '0xto...address',
    description: 'The recipient address.',
  })
  to?: string | null;

  @ApiProperty({
    example: 0.001,
    description: 'The amount of the transaction in the currency.',
  })
  amount: number;

  @ApiProperty({
    example: 1,
    description: 'The amount of the transaction in the fiat.',
  })
  fiat_amount: number;

  @ApiProperty({
    type: RiskReasonGroup,
    description: 'Detailed breakdown of AML risk reasons grouped by severity.',
  })
  risk_reasons: RiskReasonGroup;

  @ApiProperty({
    type: Object,
    example: {},
    description: "Aml Provider's raw response data.",
  })
  raw: {};
}

// --- Shared Success Base ---
class AmlCheckSuccessBaseDto {
  @ApiProperty({
    example: false,
    description: 'Indicates that the check was successfully processed.',
  })
  success: boolean;

  @ApiProperty({
    example: 85,
    description: 'A numerical risk score from 0 to 100.',
  })
  score: number;

  @ApiProperty({
    enum: AmlRiskStatusSuccess,
    example: AmlRiskStatusSuccess.High,
    description: 'The determined risk status.',
  })
  risk_status: AmlRiskStatusSuccess;

  @ApiProperty({
    type: Number,
    example: 200,
    description: 'The HTTP status code associated with the response.',
  })
  statusCode: number;

  @ApiPropertyOptional({
    example: 'AmlBot',
    description: 'The name of the AML provider that performed the check.',
  })
  provider?: string;

  @ApiPropertyOptional({
    example: 'AML check completed',
    description: 'A message providing context about the result.',
  })
  message?: string;
}

// --- Success Responses ---
export class AmlCheckSuccessAddressResponseDto extends AmlCheckSuccessBaseDto {
  @ApiProperty({
    description: 'Detailed report data for the address.',
    type: () => AmlAddressReportDto,
  })
  data: AmlAddressReportDto;
}

export class AmlCheckSuccessTransactionResponseDto extends AmlCheckSuccessBaseDto {
  @ApiProperty({
    description: 'Detailed report data for the transaction.',
    type: () => AmlTransactionReportDto,
  })
  data: AmlTransactionReportDto;
}

// --- Pending Response ---
export class AmlCheckPendingResponseDto {
  @ApiProperty({
    example: true,
    description:
      'Indicates that the check has been accepted and is being processed.',
  })
  success: boolean;

  @ApiProperty({
    type: Number,
    example: null,
    description: 'The risk score is not available yet.',
    nullable: true,
  })
  score: number | null;

  @ApiProperty({
    enum: AmlRiskStatusPending,
    example: AmlRiskStatusPending.Pending,
    description: 'The risk status is pending.',
  })
  risk_status: AmlRiskStatusPending;

  @ApiPropertyOptional({
    example: 'AmlBot',
    description: 'The AML provider handling the check.',
  })
  provider?: string;

  @ApiProperty({
    type: Object,
    example: null,
    description: 'No data is available while the check is pending.',
    nullable: true,
  })
  data: object | null;

  @ApiProperty({
    example: 'AML check started',
    description: 'A message indicating that the check has started.',
  })
  message: string;

  @ApiProperty({
    type: Number,
    example: 202,
    description: 'The HTTP status code associated with the response.',
  })
  statusCode: number;
}

// --- Error Response ---
export class AmlCheckErrorResponseDto {
  @ApiProperty({
    example: false,
    description: 'Indicates that the check failed.',
  })
  success: boolean;

  @ApiProperty({
    type: Number,
    example: null,
    description: 'The risk score is not available.',
    nullable: true,
  })
  score: number | null;

  @ApiProperty({
    enum: AmlRiskStatusError,
    example: AmlRiskStatusError.Error,
    description: 'The risk status is an error variant.',
  })
  risk_status: AmlRiskStatusError;

  @ApiPropertyOptional({
    example: 'AmlBot',
    description: 'The AML provider that encountered the error.',
  })
  provider?: string;

  @ApiProperty({
    type: Object,
    example: null,
    description: 'No data is available when an error occurs.',
    nullable: true,
  })
  data: object | null;

  @ApiProperty({
    example: 'Invalid ticker symbol.',
    description: 'A message describing the error.',
  })
  message: string;
}
