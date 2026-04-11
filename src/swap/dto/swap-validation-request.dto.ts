import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for swap validation request
 */
export class SwapValidationRequestDto {
  @ApiProperty({
    description: 'Source chain ID',
    example: '1',
  })
  @IsString()
  @IsNotEmpty({ message: 'fromChain is required' })
  fromChain: string;

  @ApiProperty({
    description: 'Source token symbol',
    example: 'ETH',
  })
  @IsString()
  @IsNotEmpty({ message: 'fromToken is required' })
  fromToken: string;

  @ApiProperty({
    description: 'Destination chain ID',
    example: '56',
  })
  @IsString()
  @IsNotEmpty({ message: 'toChain is required' })
  toChain: string;

  @ApiProperty({
    description: 'Destination token symbol',
    example: 'BNB',
  })
  @IsString()
  @IsNotEmpty({ message: 'toToken is required' })
  toToken: string;
}
