import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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
  IsUUID,
  Min,
  ValidateIf,
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

  @IsString()
  @IsOptional()
  formId?: string;
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
  @IsOptional()
  authorId?: string;

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

  @IsString()
  @IsOptional()
  associationId?: string;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedCalendarEventId?: string;

  @IsString()
  @IsOptional()
  paymentAssociationId?: string;

  @IsDateString()
  @IsOptional()
  scheduledAt?: string;
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

  /** Default `all` when omitted. */
  @IsOptional()
  @IsIn(['all', 'followed', 'custom', 'associations'])
  feed?: 'all' | 'followed' | 'custom' | 'associations';

  /** Custom feed: filter by author promotion (personal posts only). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  promo?: number;

  /** Custom feed: filter by author formation (personal posts only), substring match. */
  @IsOptional()
  @IsString()
  formation?: string;
}

export class VotePollDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  optionIds: string[];
}

export class RegisterEventDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  successUrl?: string;

  @IsString()
  @IsOptional()
  cancelUrl?: string;
}

export class SubmitFormDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsObject()
  selections: Record<string, string | string[] | number | Record<string, any>>;
}

export class AddCommentDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  text?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsObject()
  @IsOptional()
  media?: {
    mediaId: string;
    key: string;
    iv: string;
    mimeType: string;
    size: number;
    fileName?: string;
  };
}

export class AddReactionDto {
  @IsString()
  @IsNotEmpty()
  reactionType: string; // J'aime, J'adore, Triste, Joyeux, Enervé, Canari, Marteau
}

export class EditCommentDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}

export class UpdatePostDto {
  @IsString()
  @IsNotEmpty()
  markdown: string;
}

export class ReportPostDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}
