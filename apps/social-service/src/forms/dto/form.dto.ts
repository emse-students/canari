import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
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

  /** Optional help text displayed below the question label in the fill page. */
  @IsString()
  @IsOptional()
  description?: string;

  /** Optional image URL displayed above the input field in the fill page. */
  @IsString()
  @IsOptional()
  imageUrl?: string;

  /** ID of the question this question depends on (conditional display). */
  @IsString()
  @IsOptional()
  dependsOn?: string;

  /** Option label that must be selected in dependsOn question for this question to appear. */
  @IsString()
  @IsOptional()
  dependsValue?: string;
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

  @IsDateString()
  @IsOptional()
  opensAt?: string;

  @IsBoolean()
  @IsOptional()
  requiresPayment?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  paymentMethods?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormItemDto)
  items: FormItemDto[];

  @IsString()
  @IsOptional()
  ownerId?: string;

  @IsString()
  @IsOptional()
  associationId?: string;

  /** When set, grants or renews this tag to the user after a successful payment. */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  grantedTagName?: string;

  @IsDateString()
  @IsOptional()
  tagExpiresAt?: string;

  /** Whether cash (physical) payment is accepted alongside Stripe. */
  @IsBoolean()
  @IsOptional()
  allowCashPayment?: boolean;

  /** Days before an unvalidated cash submission expires. */
  @IsInt()
  @IsOptional()
  @Min(1)
  cashPaymentExpiryDays?: number;
}

export class UpdateFormDto extends CreateFormDto {}

export class SubmitFormDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsObject()
  answers: Record<string, string | string[] | number | Record<string, any>>;

  @IsString()
  @IsOptional()
  successUrl?: string;

  @IsString()
  @IsOptional()
  cancelUrl?: string;

  /** `stripe` (default) or `cash` (when the form allows it). */
  @IsString()
  @IsIn(['stripe', 'cash'])
  @IsOptional()
  paymentMethod?: string;
}
