import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { TransactionDirection } from '@aml/services/provider/aml-provider.service';
import type { AmlCheckType } from '@aml/types/aml';

import {
  IsString,
  IsOptional,
  IsIn,
  IsNotEmpty,
  ValidateIf,
  IsUrl,
  IsBoolean,
} from 'class-validator';
import { AmlCheckResposneType } from '@aml/schemas/aml-check.schema';

export class AmlCheckDto {
  @ApiProperty({
    description: 'The type of AML check to perform.',
    enum: ['address', 'transaction'],
    example: 'address',
  })
  @IsIn(['address', 'transaction'])
  @IsNotEmpty()
  type: AmlCheckType;

  @ApiProperty({
    description:
      'The ticker symbol of the cryptocurrency (e.g., "btc", "eth").',
    example: 'btc',
  })
  @IsString()
  @IsNotEmpty({ message: 'Ticker is required' })
  ticker: string;

  @ApiProperty({
    description:
      'The wallet address to check. Required when `type` is "address".',
    example: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  })
  // @ValidateIf((o) => o.type === 'address')
  @IsString()
  @IsNotEmpty({ message: 'Address is required.' })
  address: string;

  @ApiPropertyOptional({
    description:
      'The transaction hash to check. Required when `type` is "transaction".',
    example: '0x123abc...def456',
  })
  @ValidateIf((o) => o.type === 'transaction')
  @IsString()
  @IsNotEmpty({
    message: 'Transaction hash is required when type is "transaction"',
  })
  tx_hash?: string;

  @ApiPropertyOptional({
    description:
      'The direction of the transaction from the platform\'s perspective. Defaults to "deposit".',
    enum: ['deposit', 'withdrawal'],
    example: 'deposit',
    default: 'deposit',
  })
  @ValidateIf((o) => o.type === 'transaction')
  @IsOptional()
  @IsIn(['deposit', 'withdrawal'])
  direction: TransactionDirection = 'deposit';

  @ApiPropertyOptional({
    description: 'The token or contract address, if applicable.',
    example: '0x123...abc',
  })
  @IsString()
  @IsOptional()
  token?: string;

  @ApiPropertyOptional({
    description:
      'Determines the response mechanism. "sync" for a direct response, "async" for a callback-based response.',
    enum: AmlCheckResposneType,
    example: 'sync',
    default: 'sync',
  })
  @IsOptional()
  @IsIn([AmlCheckResposneType.Sync, AmlCheckResposneType.Async])
  response_type: AmlCheckResposneType = AmlCheckResposneType.Sync;

  @ApiProperty({
    description:
      'The URL to which the AML check result will be sent. Required for "async" responses and for "sync" responses that result in a "pending" status.',
    example: 'https://example.com/aml-callback',
  })
  @IsString()
  @IsUrl({ require_tld: false })
  // @IsOptional()
  callback_url: string;

  @ApiPropertyOptional({
    description:
      'Determines if the request is a fake request for testing purposes.',
    example: false,
    default: false,
  })
  @IsOptional()
  isFake?: string;

  @ApiProperty({
    description: 'The request signature to authenticate the request.',
    example: '0x123abc...def456',
  })
  @IsString()
  signature: string;

  @ApiPropertyOptional({
    description: 'The metadata associated with the request.',
    example: '{"key": "value"}',
  })
  @IsString()
  @IsOptional()
  meta_data?: string;
}
