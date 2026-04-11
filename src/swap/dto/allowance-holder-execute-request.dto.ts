import {
  IsString,
  IsNumber,
  IsOptional,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Transaction data structure from 0x API response
 */
export class TransactionDataDto {
  @ApiProperty({
    description: 'Contract address to send transaction to',
    example: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
  })
  @IsString()
  to: string;

  @ApiProperty({
    description: 'Transaction data payload',
    example: '0x...',
  })
  @IsString()
  data: string;

  @ApiProperty({
    description: 'ETH value to send with transaction (for native token swaps)',
    example: '0',
  })
  @IsString()
  value: string;

  @ApiPropertyOptional({
    description: 'Gas limit for the transaction',
    example: '200000',
  })
  @IsOptional()
  @IsString()
  gas?: string;

  @ApiPropertyOptional({
    description: 'Gas price in wei',
    example: '20000000000',
  })
  @IsOptional()
  @IsString()
  gasPrice?: string;
}

/**
 * DTO for allowance-holder swap execution request
 */
export class AllowanceHolderExecuteRequestDto {
  @ApiProperty({
    description: 'Chain ID where the swap will be executed',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  chainId: number;

  @ApiProperty({
    description:
      'Private key of the wallet executing the swap (will be used to sign transaction)',
    example: '0x1234567890abcdef...',
  })
  @IsString()
  privateKey: string;

  @ApiProperty({
    description: 'Transaction data from allowance-holder quote response',
    type: TransactionDataDto,
  })
  @ValidateNested()
  @Type(() => TransactionDataDto)
  @IsObject()
  transaction: TransactionDataDto;

  @ApiPropertyOptional({
    description: 'Address of the token being sold (for logging purposes)',
    example: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  })
  @IsOptional()
  @IsString()
  sellToken?: string;

  @ApiPropertyOptional({
    description: 'Address of the token being bought (for logging purposes)',
    example: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  })
  @IsOptional()
  @IsString()
  buyToken?: string;

  @ApiPropertyOptional({
    description: 'Amount being sold in wei (for logging purposes)',
    example: '1000000000000000000',
  })
  @IsOptional()
  @IsString()
  sellAmount?: string;

  @ApiPropertyOptional({
    description: 'Expected amount to receive in wei (for logging purposes)',
    example: '1500000000000000000',
  })
  @IsOptional()
  @IsString()
  buyAmount?: string;
}
