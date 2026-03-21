import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FormOptionDto {
  @IsString()
  @IsNotEmpty()
  label: string;

  @IsNumber()
  priceModifier: number;

  @IsString()
  @IsOptional()
  id?: string;
}

export class FormItemDto {
  @IsString()
  @IsNotEmpty()
  label: string;

  @IsBoolean()
  required: boolean;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormOptionDto)
  @IsOptional()
  options?: FormOptionDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  rows?: string[];

  @IsOptional()
  scale?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };

  @IsString()
  @IsOptional()
  id?: string;
}

export class CreateFormDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  basePrice: number;

  @IsString()
  @IsNotEmpty()
  currency: string;

  @IsString()
  @IsNotEmpty()
  submitLabel: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  maxSubmissions?: number;

  @IsBoolean()
  @IsOptional()
  requiresPayment?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormItemDto)
  items: FormItemDto[];

  @IsString()
  @IsNotEmpty()
  ownerId: string;
}

export class UpdateFormDto extends CreateFormDto {}

export class SubmitFormDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsObject()
  answers: Record<string, string | string[] | number | Record<string, any>>;
}
