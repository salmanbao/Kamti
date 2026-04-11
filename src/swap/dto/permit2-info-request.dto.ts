import {
  IsString,
  IsOptional,
  IsObject,
  ValidateNested,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AggregatorType } from '@swap/models/swap-request.model';

/**
 * Permit2 EIP-712 data structure
 */
export class Permit2Eip712Dto {
  @ApiProperty({
    description: 'EIP-712 type definitions',
    example: {
      Permit: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
  })
  @IsObject()
  types: Record<string, any>;

  @ApiProperty({
    description: 'EIP-712 domain data',
    example: {
      name: 'Permit2',
      chainId: 1,
      verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    },
  })
  @IsObject()
  domain: Record<string, any>;

  @ApiProperty({
    description: 'EIP-712 message data',
    example: {
      details: {
        token: '0xA0b86a33E6441b5e2a9c93d3bc3dd0D05a9D8f82',
        amount: '1461501637330902918203684832716283019655932542975',
        expiration: 1735689600,
        nonce: 0,
      },
      spender: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
      sigDeadline: 1735689600,
    },
  })
  @IsObject()
  message: Record<string, any>;

  @ApiProperty({
    description: 'Primary type for EIP-712',
    example: 'Permit',
  })
  @IsString()
  primaryType: string;
}

/**
 * Permit2 data structure
 */
export class Permit2DataDto {
  @ApiProperty({
    description: 'Permit2 type identifier',
    example: 'permit2',
  })
  @IsString()
  type: string;

  @ApiProperty({
    description: 'Permit2 hash',
    example: '0x1234567890abcdef...',
  })
  @IsString()
  hash: string;

  @ApiProperty({
    description: 'EIP-712 signature data',
    type: Permit2Eip712Dto,
  })
  @ValidateNested()
  @Type(() => Permit2Eip712Dto)
  eip712: Permit2Eip712Dto;
}

/**
 * DTO for permit2 info request (SwapQuote with permit2 data)
 */
export class Permit2InfoRequestDto {
  @ApiProperty({
    description: 'Address of token being sold',
    example: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  })
  @IsString()
  sellToken: string;

  @ApiProperty({
    description: 'Address of token being bought',
    example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  })
  @IsString()
  buyToken: string;

  @ApiProperty({
    description: 'Amount of sell token in wei',
    example: '1000000000000000000',
  })
  @IsString()
  sellAmount: string;

  @ApiProperty({
    description: 'Amount of buy token in wei',
    example: '1500000000',
  })
  @IsString()
  buyAmount: string;

  @ApiProperty({
    description: 'Minimum buy amount with slippage',
    example: '1485000000',
  })
  @IsString()
  minBuyAmount: string;

  @ApiProperty({
    description: 'Gas limit for the transaction',
    example: '200000',
  })
  @IsString()
  gas: string;

  @ApiPropertyOptional({
    description: 'Gas price in wei',
    example: '20000000000',
  })
  @IsOptional()
  @IsString()
  gasPrice?: string;

  @ApiProperty({
    description: 'Target contract address',
    example: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
  })
  @IsString()
  to: string;

  @ApiProperty({
    description: 'Transaction data',
    example: '0x...',
  })
  @IsString()
  data: string;

  @ApiProperty({
    description: 'ETH value to send',
    example: '0',
  })
  @IsString()
  value: string;

  @ApiPropertyOptional({
    description: 'Address to approve for spending',
    example: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  })
  @IsOptional()
  @IsString()
  allowanceTarget?: string;

  @ApiProperty({
    description: 'Aggregator used for the quote',
    example: AggregatorType.ZEROX,
    enum: AggregatorType,
  })
  @IsEnum(AggregatorType)
  aggregator: AggregatorType;

  @ApiPropertyOptional({
    description: 'Price impact percentage',
    example: '0.05',
  })
  @IsOptional()
  @IsString()
  priceImpact?: string;

  @ApiPropertyOptional({
    description: 'Estimated gas usage',
    example: '180000',
  })
  @IsOptional()
  @IsString()
  estimatedGas?: string;

  @ApiPropertyOptional({
    description: 'Permit2 data for gasless approvals',
    type: Permit2DataDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => Permit2DataDto)
  permit2?: Permit2DataDto;
}
