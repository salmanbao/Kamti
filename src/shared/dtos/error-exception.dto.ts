import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsString,
  IsObject,
  ValidateNested,
  Min,
} from 'class-validator';

export class ErrorDetailDto {
  @ApiProperty({ description: 'HTTP status code', example: 400 })
  @IsNumber()
  @Min(100) // HTTP codes are 3-digit
  statusCode: number;

  @ApiProperty({ description: 'Error message', example: 'Bad Request' })
  @IsString()
  message: string;

  @ApiProperty({ description: 'Error details', example: 'Validation failed' })
  @IsString()
  error: string;

  @ApiProperty({ description: 'Request path', example: '/api/users' })
  @IsString()
  path: string;

  @ApiProperty({ description: 'HTTP method', example: 'POST' })
  @IsString()
  method: string;
}

export class ErrorResponseDto {
  @ApiProperty({ description: 'Indicates success', example: false })
  @IsBoolean()
  success: false;

  @ApiProperty({ description: 'Error details' })
  @IsObject()
  @ValidateNested()
  error: ErrorDetailDto;

  @ApiProperty({
    description: 'Timestamp of the error',
    example: '2023-10-01T12:00:00.000Z',
  })
  @IsString()
  timestamp: string;
}

export class BadRequestErrorResponseDto extends ErrorResponseDto {
  @ApiProperty({ description: 'Always 400 for bad requests' })
  error: ErrorDetailDto & { statusCode: 400 } = {} as any;
}

export class InternalServerErrorResponseDto extends ErrorResponseDto {
  @ApiProperty({ description: 'Always 500 for server errors' })
  error: ErrorDetailDto & { statusCode: 500 } = {} as any;
}

export class NotFoundErrorResponseDto extends ErrorResponseDto {
  @ApiProperty({ description: 'Always 404 for not found' })
  error: ErrorDetailDto & { statusCode: 404 } = {} as any;
}
