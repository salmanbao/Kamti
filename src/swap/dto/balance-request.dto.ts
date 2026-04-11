import { IsString, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for balance check request
 */
export class BalanceRequestDto {
  @ApiProperty({
    description: 'Chain ID',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  chainId: number;

  @ApiProperty({
    description: 'Wallet address to check balance for',
    example: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
  })
  @IsString()
  walletAddress: string;

  @ApiPropertyOptional({
    description: 'Token address (omit for native token balance)',
    example: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
  })
  @IsOptional()
  @IsString()
  tokenAddress?: string;
}

/**
 * DTO for multiple token balances request
 */
export class MultiBalanceRequestDto {
  @ApiProperty({
    description: 'Chain ID',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  chainId: number;

  @ApiProperty({
    description: 'Wallet address to check balances for',
    example: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
  })
  @IsString()
  walletAddress: string;

  @ApiProperty({
    description: 'Array of token addresses to check balances for',
    example: [
      '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
      '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
    ],
  })
  @IsString({ each: true })
  tokenAddresses: string[];
}
