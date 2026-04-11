import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BlockchainEcosystem,
  TokenStandard,
} from './universal-swap-request.dto';

/**
 * Chain information for capability checking
 */
export class ChainCapabilityInfo {
  @ApiProperty({
    description: 'Chain ID',
    example: 1,
  })
  @IsNumber()
  chainId: number;

  @ApiProperty({
    description: 'Blockchain ecosystem',
    enum: BlockchainEcosystem,
    example: BlockchainEcosystem.EVM,
  })
  @IsEnum(BlockchainEcosystem)
  ecosystem: BlockchainEcosystem;

  @ApiPropertyOptional({
    description: 'Chain name (optional)',
    example: 'Ethereum Mainnet',
  })
  @IsOptional()
  @IsString()
  name?: string;
}

/**
 * Token information for capability checking
 */
export class TokenCapabilityInfo {
  @ApiProperty({
    description: 'Token symbol',
    example: 'USDT',
  })
  @IsString()
  symbol: string;

  @ApiProperty({
    description: 'Token contract address (for non-native tokens)',
    example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    required: false,
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({
    description: 'Chain information',
  })
  @ValidateNested()
  @Type(() => ChainCapabilityInfo)
  chain: ChainCapabilityInfo;

  @ApiPropertyOptional({
    description: 'Token standard',
    enum: TokenStandard,
    example: TokenStandard.ERC20,
  })
  @IsOptional()
  @IsEnum(TokenStandard)
  standard?: TokenStandard;
}

/**
 * Capability Check Request DTO
 */
export class CapabilityCheckRequestDto {
  @ApiProperty({
    description: 'Source token information',
  })
  @ValidateNested()
  @Type(() => TokenCapabilityInfo)
  sellToken: TokenCapabilityInfo;

  @ApiProperty({
    description: 'Destination token information',
  })
  @ValidateNested()
  @Type(() => TokenCapabilityInfo)
  buyToken: TokenCapabilityInfo;

  @ApiPropertyOptional({
    description: 'Amount to swap (optional for capability check)',
    example: '1000000000000000000',
  })
  @IsOptional()
  @IsString()
  amount?: string;

  @ApiPropertyOptional({
    description: 'Preferred provider category',
    enum: ['evm-aggregators', 'meta', 'solana'],
  })
  @IsOptional()
  @IsString()
  preferredCategory?: string;

  @ApiPropertyOptional({
    description: 'Preferred specific provider',
    example: '0x',
  })
  @IsOptional()
  @IsString()
  preferredProvider?: string;
}
