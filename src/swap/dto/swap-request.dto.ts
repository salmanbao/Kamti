import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  Min,
  Max,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AggregatorType, ApprovalStrategy } from '../models/swap-request.model';

/**
 * DTO for swap quote request
 */
export class SwapQuoteRequestDto {
  @ApiProperty({
    description: 'Chain ID for the swap',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  chainId: number;

  @ApiProperty({
    description:
      'Token address to sell (use 0x0000000000000000000000000000000000000000 for native token)',
    example: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  })
  @IsString()
  sellToken: string;

  @ApiProperty({
    description:
      'Token address to buy (use 0x0000000000000000000000000000000000000000 for native token)',
    example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  })
  @IsString()
  buyToken: string;

  @ApiProperty({
    description: 'Amount to sell in wei',
    example: '1000000000000000000',
  })
  @IsString()
  sellAmount: string;

  @ApiProperty({
    description: 'Wallet address that will execute the swap',
    example: '0x9C30214BeBfC3cD36aA4A11a9540e019f2951c5C',
  })
  @IsString()
  taker: string;

  @ApiPropertyOptional({
    description: 'Recipient address (defaults to taker if not provided)',
    example: '0x9C30214BeBfC3cD36aA4A11a9540e019f2951c5C',
  })
  @IsOptional()
  @IsString()
  recipient?: string;

  @ApiPropertyOptional({
    description: 'Maximum slippage percentage (0-50)',
    example: 0.5,
    minimum: 0,
    maximum: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  @Type(() => Number)
  slippagePercentage?: number;

  @ApiPropertyOptional({
    description: 'Transaction deadline timestamp in seconds',
    example: 1704067200,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  deadline?: number;

  @ApiPropertyOptional({
    description:
      'Preferred aggregator to use (0x, velora, odos, kyberswap, jupiter)',
    enum: AggregatorType,
    example: AggregatorType.ZEROX,
  })
  @IsOptional()
  @IsEnum(AggregatorType)
  aggregator?: AggregatorType;

  @ApiPropertyOptional({
    description: 'Approval strategy for 0x Protocol v2',
    enum: ApprovalStrategy,
    example: ApprovalStrategy.ALLOWANCE_HOLDER,
  })
  @IsOptional()
  @IsEnum(ApprovalStrategy)
  approvalStrategy?: ApprovalStrategy;

  @IsOptional()
  @IsBoolean({
    message: 'strictValidation must be either "strict" or "lenient"',
  })
  strictValidation?: false;
}

/**
 * DTO for swap execution request
 */
export class SwapExecutionRequestDto {
  @ApiProperty({
    description: 'Chain ID for the swap',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  chainId: number;

  @ApiProperty({
    description: 'Token address to sell',
    example: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  })
  @IsString()
  sellToken: string;

  @ApiProperty({
    description: 'Token address to buy',
    example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  })
  @IsString()
  buyToken: string;

  @ApiProperty({
    description: 'Amount to sell in wei',
    example: '1000000000000000000',
  })
  @IsString()
  sellAmount: string;

  @ApiProperty({
    description: 'Wallet private key for signing transactions',
    example:
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  })
  @IsString()
  privateKey: string;

  @ApiPropertyOptional({
    description:
      'Recipient address (defaults to wallet address if not provided)',
    example: '0x9C30214BeBfC3cD36aA4A11a9540e019f2951c5C',
  })
  @IsOptional()
  @IsString()
  recipient?: string;

  @ApiPropertyOptional({
    description: 'Maximum slippage percentage (0-50)',
    example: 0.5,
    minimum: 0,
    maximum: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  @Type(() => Number)
  slippagePercentage?: number;

  @ApiPropertyOptional({
    description: 'Transaction deadline timestamp in seconds',
    example: 1704067200,
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  deadline?: number;

  @ApiPropertyOptional({
    description:
      'Preferred aggregator to use (0x, velora, odos, kyberswap, jupiter)',
    enum: AggregatorType,
    example: AggregatorType.ZEROX,
  })
  @IsOptional()
  @IsEnum(AggregatorType)
  aggregator?: AggregatorType;
}
