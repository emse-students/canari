import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsNumber,
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
