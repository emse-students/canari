import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
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
} from "class-validator";
import { Type } from "class-transformer";
import { AssociationCalendarEventKind } from "../entities/association-calendar-event.entity";

export class ReorderMembersDto {
  /** Ordered list of member user IDs - position in the array becomes the new sortOrder. */
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
    message: "slug must be lowercase alphanumeric with hyphens",
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

  /** Public contact e-mail shown on the trombinoscope and the association page. */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  contactEmail?: string;

  /** 'association' (default) or 'list' (promo list). */
  @IsIn(["association", "list"])
  @IsOptional()
  type?: "association" | "list";

  /** Lists only: the promotion year the list belongs to (e.g. 2027). */
  @IsInt()
  @Min(1900)
  @Max(2100)
  @IsOptional()
  promo?: number;

  /** Lists only: optional parent association (e.g. the owning BDE). */
  @IsUUID()
  @IsOptional()
  parentAssociationId?: string;

  /** Lists only: optional second theme name. */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name2?: string;

  /** Lists only: optional second theme logo (media-service UUID). */
  @IsUUID()
  @IsOptional()
  logoMediaId2?: string;
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

  /** Primary thematic category id (managed table). Pass `""`/`null` to clear (uncategorised). */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === "string" && v.length > 0)
  @IsUUID()
  categoryId?: string | null;

  /** When true, archives the association (moves it to "Anciennes", hides from "Mes associations"). */
  @IsBoolean()
  @IsOptional()
  archived?: boolean;

  /** Public contact e-mail. Pass `""` to clear; stored as null when blank. */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  contactEmail?: string | null;

  /** Lists only: the promotion year. */
  @IsInt()
  @Min(1900)
  @Max(2100)
  @IsOptional()
  promo?: number | null;

  /** Lists only: optional parent association. */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === "string" && v.length > 0)
  @IsUUID()
  parentAssociationId?: string | null;

  /** Lists only: optional second theme name. Pass `""` to clear (stored as null). */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name2?: string | null;

  /** Lists only: optional second theme logo. Pass `""`/null to clear. */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === "string" && v.length > 0)
  @IsUUID()
  logoMediaId2?: string | null;

  /** Reveals the Cotisations admin tab. Requires MANAGE_PRODUCTS (enforced by the controller). */
  @IsBoolean()
  @IsOptional()
  cotisationEnabled?: boolean;

  /** Validity mode of the cotisation. Required when enabling; pass `null` to clear when disabling. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(["lifetime", "dated"])
  cotisationMode?: "lifetime" | "dated" | null;

  /** Deadline for the current `dated` period. Pass `null` to clear. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  cotisationExpiresAt?: string | null;
}

export class RequestPaymentDelegationDto {
  /** Parent association whose Stripe account should receive this association's payments. */
  @IsUUID()
  @IsNotEmpty()
  parentAssociationId: string;
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
  @Max(1023) // 2^10 - 1 covers all 10 current flags
  // Note: BDE-only flags (VALIDATE_EVENTS=32, MANAGE_ASSO=64, MODERATE=128) are silently
  // inert when the association is not marked isBDE=true in the DB.
  permissions: number;
}

export class UpdateMemberRoleDto {
  @IsString()
  @IsOptional()
  role?: string;

  /** Bitmask of `AssociationPermissionFlag` values. */
  @IsInt()
  @Min(0)
  @Max(1023)
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

  /** Original uploaded file name (with extension), preserved for download. */
  @IsString()
  @IsOptional()
  @MaxLength(255)
  originalFilename?: string;
}

/** Partial update of a vault document: rename the display name and/or change visibility. */
export class UpdateAssociationDocumentDto {
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  /** `public` is rejected for password-protected documents (enforced in the service). */
  @IsIn(["private", "public"])
  @IsOptional()
  visibility?: "private" | "public";
}

/** Body for granting global document-reviewer access to a user. */
export class AddDocumentReviewerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  userId: string;
}

/** Payload for the association's vault-encrypted shared notepad (opaque ciphertext). */
export class UpdateAssociationNotesDto {
  /** Base64-encoded AES-256-GCM packed blob (IV + ciphertext). Empty clears the note. */
  @IsString()
  @MaxLength(2_000_000)
  @IsOptional()
  ciphertext?: string;
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

  /** Visual kind: `event` (default, a card) or `break` (a full-day background band). */
  @IsOptional()
  @IsEnum(AssociationCalendarEventKind)
  kind?: AssociationCalendarEventKind;

  /** Optional form (same association). */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === "string" && v.length > 0)
  @IsUUID()
  linkedFormId?: string;

  /**
   * BDE / global admin only: create the event on behalf of another association.
   * When set, overrides the `:id` route param as the target association.
   */
  @IsOptional()
  @IsUUID()
  targetAssocId?: string;

  /** Additional associations co-managing this event (max 10). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID("all", { each: true })
  coOwnerIds?: string[];
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

  /** Visual kind: `event` (a card) or `break` (a full-day background band). */
  @IsOptional()
  @IsEnum(AssociationCalendarEventKind)
  kind?: AssociationCalendarEventKind;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === "string" && v.length > 0)
  @IsUUID()
  linkedFormId?: string | null;

  /** Replaces the full co-owner list for this event (max 10). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID("all", { each: true })
  coOwnerIds?: string[];
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

  @IsIn(["membership", "balance_topup", "other"])
  type: "membership" | "balance_topup" | "other";

  @IsString()
  @IsOptional()
  @MaxLength(100)
  grantedTagName?: string;

  @IsDateString()
  @IsOptional()
  tagExpiresAt?: string;

  /** Reserved to holders of the association's active cotisation tag. */
  @IsBoolean()
  @IsOptional()
  membersOnly?: boolean;

  /** Reduced price in cents for cotisants (defaults to `amountCents` when omitted). */
  @IsInt()
  @Min(0)
  @IsOptional()
  amountCentsMember?: number;

  /** Named cotisation tier (e.g. "avec-alcool"), suffixed onto the derived cotisation tag. */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  variantKey?: string;

  /** Ordinal rank of this tier for future "tier >= N" checks (WP-COT-8). */
  @IsInt()
  @IsOptional()
  variantLevel?: number;

  /** Sibling tier's tag that qualifies the buyer for `amountCentsMember` (tier upgrade pricing). */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  memberPriceTag?: string;

  /** Arbitrary tag names gating purchase eligibility (buyer must hold ANY). Overrides `membersOnly`. */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requiredTags?: string[];

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

  @IsBoolean()
  @IsOptional()
  allowRepeatPurchase?: boolean;

  @IsInt()
  @Min(1)
  @IsOptional()
  maxPurchasesPerUser?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  maxPurchasesTotal?: number;
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

  /** Reserved to holders of the association's active cotisation tag. */
  @IsBoolean()
  @IsOptional()
  membersOnly?: boolean;

  /** Reduced price in cents for cotisants. Pass `null` to charge cotisants the same as everyone. */
  @IsInt()
  @Min(0)
  @IsOptional()
  amountCentsMember?: number | null;

  /** Named cotisation tier (e.g. "avec-alcool"), suffixed onto the derived cotisation tag. */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  variantKey?: string | null;

  /** Ordinal rank of this tier for future "tier >= N" checks (WP-COT-8). */
  @IsInt()
  @IsOptional()
  variantLevel?: number | null;

  /** Sibling tier's tag that qualifies the buyer for `amountCentsMember` (tier upgrade pricing). */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  memberPriceTag?: string | null;

  /** Arbitrary tag names gating purchase eligibility (buyer must hold ANY). Overrides `membersOnly`. */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requiredTags?: string[] | null;

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

  @IsBoolean()
  @IsOptional()
  allowRepeatPurchase?: boolean;

  @IsInt()
  @Min(1)
  @IsOptional()
  maxPurchasesPerUser?: number | null;

  @IsInt()
  @Min(1)
  @IsOptional()
  maxPurchasesTotal?: number | null;
}

/** DTO for manually recording a product purchase (cash, retroactive, etc.). */
export class GrantProductPurchaseDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  /** Amount in cents; required when the product has no fixed price. */
  @IsInt()
  @Min(0)
  @IsOptional()
  amountCents?: number;
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

/** Query params for GET :id/cotisants (roster search + offset pagination). */
export class ListCotisantsQueryDto {
  /** Case-insensitive substring match on first/last name. */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /** Capped at 200 by the service regardless of the value requested here. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Body for manually adding a cotisant (grants the association's canonical cotisation tag). */
export class GrantCotisantDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}
