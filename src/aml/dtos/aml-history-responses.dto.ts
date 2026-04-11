import { ApiProperty } from '@nestjs/swagger';
import { AmlRiskStatusSuccess } from './aml-responses.dto';

export class AmlHistoryItemDto {
  @ApiProperty({
    description: 'Unique identifier for the AML check history item',
    example: 1,
  })
  id: number;

  @ApiProperty({
    description: 'Blockchain or chain of the asset',
    example: 'btc',
  })
  chain: string;

  @ApiProperty({
    description: 'Token symbol if available',
    example: null,
    nullable: true,
  })
  token: string | null;

  @ApiProperty({ description: 'Type of AML check', example: 'UNKNOWN' })
  type: string;

  @ApiProperty({
    description: 'Risk level returned by AML provider',
    enum: AmlRiskStatusSuccess,
    example: AmlRiskStatusSuccess.High,
  })
  riskLevel: AmlRiskStatusSuccess;

  @ApiProperty({ description: 'Wallet address checked', example: 'bc1abc...' })
  address: string | null;

  @ApiProperty({
    description: 'Transaction hash checked (if type is transaction)',
    example: '0x123abc...',
    nullable: true,
  })
  txHash: string | null;

  @ApiProperty({
    description: 'Indicates if the check was performed on a token',
    example: false,
  })
  isToken: boolean;

  @ApiProperty({
    description: 'Timestamp when the item was checked',
    example: null,
    nullable: true,
  })
  checkedAt: Date | null;

  @ApiProperty({
    description: 'Calculated risk score (0–100)',
    example: 85,
  })
  score: number;

  @ApiProperty({
    description: 'Sources or risk reasons returned by AML provider',
    example: ['High-risk exchange', 'Sanctioned address'],
    type: [String],
  })
  sources: string[];

  @ApiProperty({
    description: 'Pdf report link from the AML provider',
    example: 'https://provider.com/reports/aml_report_12345.pdf',
    nullable: true,
  })
  pdf_link: string | null;

  @ApiProperty({
    description: 'Raw provider response for debugging',
    example: {},
  })
  _raw: Record<string, any>;
}

class AmlHistoryPagination {
  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Number of items per page' })
  pageSize: number;

  @ApiProperty({ description: 'Total number of AML check history items' })
  total: number;

  @ApiProperty({ description: 'Total number of pages' })
  pageCount: number;
}

export class AmlHistoryPaginatedResponseDto {
  @ApiProperty({
    example: true,
    description: 'Indicates that the check failed.',
  })
  success: boolean;

  @ApiProperty({
    type: AmlHistoryPagination,
    description: 'Object contains pagination information.',
  })
  pagination: AmlHistoryPagination;

  @ApiProperty({
    type: [AmlHistoryItemDto],
    description: 'Array of AML check history items',
  })
  data: AmlHistoryItemDto[];

  @ApiProperty({
    example: 'AmlBot',
    description: 'The AML provider that encountered the error.',
  })
  provider: string;

  @ApiProperty({
    type: Number,
    example: 200,
    description: 'The HTTP status code associated with the response.',
  })
  statusCode: number;
}
