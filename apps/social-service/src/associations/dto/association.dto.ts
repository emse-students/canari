import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class ReorderMembersDto {
  /** Ordered list of member user IDs — position in the array becomes the new sortOrder. */
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}

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

  /** Pass `""` to clear; stored as null when blank. */
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(16000)
  bioMarkdown?: string | null;

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

  /** Hex color for calendar display. Pass `""` or `null` to clear (reverts to auto-generated color). */
  @IsOptional()
  @IsString()
  @Matches(/^(#[0-9A-Fa-f]{6})?$/)
  color?: string | null;
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

export class CreateAssociationDocumentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(4000)
  description?: string;

  /** UUID returned by media-service after the encrypted blob upload. */
  @IsUUID()
  mediaId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  mimeType: string;

  /** Original file size in bytes (before encryption overhead). */
  @IsInt()
  @Min(0)
  size: number;
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

  /**
   * BDE / global admin only: create the event on behalf of another association.
   * When set, overrides the `:id` route param as the target association.
   */
  @IsOptional()
  @IsUUID()
  targetAssocId?: string;
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

/** Optional reason provided by the BDE when rejecting a pending calendar event. */
export class RejectCalendarEventDto {
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  reason?: string;
}

/** DTO for creating a boutique product. */
export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** Fixed price in cents; null if only custom amounts are allowed. */
  @IsInt()
  @Min(1)
  @IsOptional()
  amountCents?: number;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  currency?: string;

  @IsIn(['membership', 'balance_topup', 'other'])
  type: 'membership' | 'balance_topup' | 'other';

  @IsString()
  @IsOptional()
  @MaxLength(100)
  grantedTagName?: string;

  @IsDateString()
  @IsOptional()
  tagExpiresAt?: string;

  @IsBoolean()
  @IsOptional()
  allowCustomAmount?: boolean;

  @IsInt()
  @Min(1)
  @IsOptional()
  customAmountMinCents?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  customAmountMaxCents?: number;

  /** Cercle webhook URL (balance_topup products). */
  @IsUrl()
  @IsOptional()
  webhookUrl?: string;

  /** HMAC-SHA256 secret for signing Cercle webhook payloads. */
  @IsString()
  @IsOptional()
  @MaxLength(200)
  webhookSecret?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

/** DTO for partial updates to a boutique product. All fields optional. */
export class UpdateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  amountCents?: number | null;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  currency?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  grantedTagName?: string | null;

  @IsDateString()
  @IsOptional()
  tagExpiresAt?: string | null;

  @IsBoolean()
  @IsOptional()
  allowCustomAmount?: boolean;

  @IsInt()
  @Min(1)
  @IsOptional()
  customAmountMinCents?: number | null;

  @IsInt()
  @Min(1)
  @IsOptional()
  customAmountMaxCents?: number | null;

  @IsUrl()
  @IsOptional()
  webhookUrl?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  webhookSecret?: string | null;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

/** DTO for manually granting a cotisation tag to a user. */
export class GrantTagDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tagName: string;

  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}
