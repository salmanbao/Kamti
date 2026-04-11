import {
  IsString,
  IsNotEmpty,
  IsArray,
  IsOptional,
  IsUrl,
} from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ipAddresses?: string[];

  @IsUrl()
  @IsOptional()
  url?: string;
}
