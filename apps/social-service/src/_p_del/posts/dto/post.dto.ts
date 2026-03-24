import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PostImageDto {
  @IsString()
  @IsNotEmpty()
  mediaId: string;

  @IsString()
  @IsNotEmpty()
  key: string;

  @IsString()
  @IsNotEmpty()
  iv: string;

  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @IsNumber()
  @Min(0)
  size: number;

  @IsString()
  @IsOptional()
  fileName?: string;
}

export class PollOptionInputDto {
  @IsString()
  @IsNotEmpty()
  label: string;
}

export class PollInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  question: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => PollOptionInputDto)
  options: PollOptionInputDto[];

  @IsBoolean()
  @IsOptional()
  multipleChoice?: boolean;

  @IsDateString()
  @IsOptional()
  endsAt?: string;
}

export class EventButtonInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsBoolean()
  @IsOptional()
  requiresPayment?: boolean = false;

  @IsNumber()
  @Min(0)
  @IsOptional()
  amountCents?: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsString()
  @IsOptional()
  stripePriceId?: string;

  @IsNumber()
  @Min(1)
  @IsOptional()
  capacity?: number;
}

export class FormOptionInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsNumber()
  priceModifier: number;
}

export class FormItemInputDto {
  @IsString()
  @IsOptional()
  id?: string;

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
  @Type(() => FormOptionInputDto)
  @IsOptional()
  options?: FormOptionInputDto[];

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
}

export class FormInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsNumber()
  @Min(0)
  basePrice: number;

  @IsString()
  currency: string;

  @IsString()
  @IsNotEmpty()
  submitLabel: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormItemInputDto)
  items: FormItemInputDto[];
}

export class CreatePostDto {
  @IsString()
  @IsNotEmpty()
  authorId: string;

  @IsString()
  @IsNotEmpty()
  markdown: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostImageDto)
  images?: PostImageDto[];

  @IsString()
  @IsOptional()
  attachedFormId?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PollInputDto)
  polls?: PollInputDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => EventButtonInputDto)
  eventButtons?: EventButtonInputDto[];
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FormInputDto)
  forms?: FormInputDto[];
}

export class ListPostsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  offset?: number;
}

export class VotePollDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  optionIds: string[];
}

export class RegisterEventDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  email?: string;
}

export class SubmitFormDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsObject()
  selections: Record<string, string | string[] | number | Record<string, any>>;
}
