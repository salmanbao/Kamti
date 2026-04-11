import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsInt,
  Min,
  IsBoolean,
} from 'class-validator';

// --- DTOs ---

export class AmlHistoryDto {
  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  fromDate?: Date;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  toDate?: Date;

  @ApiPropertyOptional({ enum: ['low', 'medium', 'high'] })
  @IsIn(['low', 'medium', 'high'])
  @IsOptional()
  status?: 'low' | 'medium' | 'high';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({
    description: 'Sort order, e.g. "createdAt:desc"',
    enum: ['createdAt:asc', 'createdAt:desc'],
  })
  @IsString()
  @IsOptional()
  @IsIn(['createdAt:asc', 'createdAt:desc'])
  sortBy?: string;

  @ApiPropertyOptional({ default: 1, type: Number })
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 10, type: Number })
  @IsInt()
  @Min(1)
  @IsOptional()
  pageSize?: number;

  @ApiPropertyOptional({
    type: String,
    example: '0x123abc...def456',
    description: 'The transaction hash or address to search for.',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description:
      'Determines if the request is a fake request for testing purposes.',
    example: false,
    default: false,
  })
  @IsOptional()
  isFake?: string;

  @ApiProperty({
    description: 'The request signature to authenticate the request.',
    example: '0x123abc...def456',
  })
  @IsString()
  signature: string;
}
