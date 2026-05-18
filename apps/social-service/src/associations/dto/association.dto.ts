import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateAssociationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric with hyphens',
  })
  slug: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16000)
  bioMarkdown?: string;

  @IsString()
  @IsOptional()
  logoUrl?: string;
}

export class UpdateAssociationDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16000)
  bioMarkdown?: string;

  @IsString()
  @IsOptional()
  logoUrl?: string;

  /** Only global admins may toggle this. */
  @IsBoolean()
  @IsOptional()
  isBDE?: boolean;

  /** Only global admins may change this. Default 500 MiB. */
  @IsInt()
  @Min(0)
  @IsOptional()
  documentQuotaBytes?: number;
}

export class AddMemberDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  /**
   * Bitmask of `AssociationPermissionFlag` values.
   * 0 = simple member; combine flags with bitwise OR.
   */
  @IsInt()
  @Min(0)
  @Max(511) // 2^9 - 1 covers all 9 current flags
  permissions: number;
}

export class UpdateMemberRoleDto {
  @IsString()
  @IsOptional()
  role?: string;

  /** Bitmask of `AssociationPermissionFlag` values. */
  @IsInt()
  @Min(0)
  @Max(511)
  @IsOptional()
  permissions?: number;
}

export class AddMembersBatchDto {
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}

export class CreateAssociationCalendarEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(4000)
  description?: string;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  /** Optional form (same association). */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedFormId?: string;
}

export class UpdateAssociationCalendarEventDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @IsString()
  @IsOptional()
  @MaxLength(4000)
  description?: string;

  @IsDateString()
  @IsOptional()
  startsAt?: string;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedFormId?: string | null;
}
