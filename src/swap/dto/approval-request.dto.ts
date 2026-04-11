import { IsString, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for token approval request
 */
export class ApprovalRequestDto {
  @ApiProperty({
    description: 'Chain ID for the approval',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  chainId: number;

  @ApiProperty({
    description: 'Token address to approve',
    example: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
  })
  @IsString()
  tokenAddress: string;

  @ApiProperty({
    description: 'Spender address to approve',
    example: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
  })
  @IsString()
  spender: string;

  @ApiProperty({
    description: 'Amount to approve in wei (use "0" for unlimited)',
    example: '1000000000000000000',
  })
  @IsString()
  amount: string;

  @ApiProperty({
    description: 'Wallet private key for signing the approval transaction',
    example:
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  })
  @IsString()
  privateKey: string;
}

/**
 * DTO for checking approval status
 */
export class ApprovalStatusRequestDto {
  @ApiProperty({
    description: 'Chain ID',
    example: 1,
  })
  @IsNumber()
  @Type(() => Number)
  chainId: number;

  @ApiProperty({
    description: 'Token address',
    example: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
  })
  @IsString()
  tokenAddress: string;

  @ApiProperty({
    description: 'Spender address',
    example: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
  })
  @IsString()
  spender: string;

  @ApiProperty({
    description: 'Owner address',
    example: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
  })
  @IsString()
  owner: string;

  @ApiPropertyOptional({
    description:
      'Amount to check approval for (optional - if provided, checks if current allowance is sufficient)',
    example: '1000000000000000000',
  })
  @IsOptional()
  @IsString()
  amount?: string;
}
