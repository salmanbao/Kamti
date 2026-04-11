import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsUrl,
  IsNumber,
  IsUUID,
} from 'class-validator';
import { RequestEnviornment } from '@swift/types/swift.types';

export class SwiftCheckDto {
  @ApiProperty({
    description:
      'The UETR (Unique End-to-End Transaction Reference) number of the transaction.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty({ message: 'UETR is required.' })
  @IsUUID('4', { message: 'UETR must be a valid UUID v4.' })
  uetr: string;

  @ApiProperty({
    description: 'The callback URL to receive the status of the transaction.',
    example: 'https://example.com/callback',
  })
  @IsString()
  @IsUrl({ require_tld: false })
  callback_url: string;

  @ApiPropertyOptional({
    description:
      'Determines if the request is for a test or production environment.',
    example: RequestEnviornment.SANDBOX,
    default: RequestEnviornment.PRODUCTION,
    enum: [RequestEnviornment.SANDBOX, RequestEnviornment.PRODUCTION],
  })
  @IsOptional()
  enviornment?: RequestEnviornment;

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

  @ApiPropertyOptional({
    description:
      'The recheck_after value to determine when to recheck the transaction. (in seconds). If not provided, the default value is 6 hours.',
    example: 6 * 60 * 60 * 1000,
  })
  @IsNumber()
  @IsOptional()
  recheck_after?: number;
}
