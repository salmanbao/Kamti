import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

/**
 * DTO for parsing transaction data
 */
export class TransactionParseRequestDto {
  @ApiProperty({
    description: 'Transaction hash to parse',
    example:
      '0x2fc205711fc933ef6e5bcc0bf6e6a9bfc220b2d8073aea4f41305882f485669d',
  })
  @IsString()
  @IsNotEmpty()
  transactionHash: string;

  @ApiProperty({
    description: 'Chain ID for the transaction',
    example: 1,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(999999)
  chainId?: number;
}

/**
 * DTO for transaction parse response
 */
export class TransactionParseResponseDto {
  @ApiProperty({
    description: 'Transaction hash',
    example:
      '0x2fc205711fc933ef6e5bcc0bf6e6a9bfc220b2d8073aea4f41305882f485669d',
  })
  transactionHash: string;

  @ApiProperty({
    description: 'Chain ID',
    example: 1,
  })
  chainId: number;

  @ApiProperty({
    description: 'Block number',
    example: 18500000,
  })
  blockNumber: number;

  @ApiProperty({
    description: 'Transaction status',
    example: 'success',
  })
  status: string;

  @ApiProperty({
    description: 'Gas used',
    example: '150000',
  })
  gasUsed: string;

  @ApiProperty({
    description: 'Gas price in wei',
    example: '20000000000',
  })
  gasPrice: string;

  @ApiProperty({
    description: 'From address',
    example: '0x742d35Cc6635C0532925a3b8D5c34ac8D8C8b65E',
  })
  from: string;

  @ApiProperty({
    description: 'To address',
    example: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
  })
  to: string;

  @ApiProperty({
    description: 'Transaction value in wei',
    example: '1000000000000000000',
  })
  value: string;

  @ApiProperty({
    description: 'Parsed swap data if available',
    required: false,
  })
  swapData?: {
    inputToken: {
      address: string;
      symbol?: string;
      decimals?: number;
      amount: string;
      amountFormatted?: string;
    };
    outputToken: {
      address: string;
      symbol?: string;
      decimals?: number;
      amount: string;
      amountFormatted?: string;
    };
    trader: string;
    recipient?: string;
    protocol?: string;
    source?: string;
  };

  @ApiProperty({
    description: 'Raw parsed transaction data',
    required: false,
  })
  rawParsedData?: any;
}
