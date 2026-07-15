import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/** Strips control/format chars and applies NFKC normalization to prevent homoglyph attacks. */
const NormalizeText = () =>
  Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string'
      ? value
          .normalize('NFKC')
          .replace(/[\p{Cc}\p{Cf}]/gu, '')
          .trim()
      : value
  );

/**
 * Like {@link NormalizeText} but preserves newlines and tabs, for multi-line fields (e.g. bio).
 * A newline (U+000A) is a control char (`\p{Cc}`), so the plain NormalizeText strips it - which
 * silently deleted every line break on save. Here we keep `\n` and `\t` while still removing the
 * dangerous control/format chars (zero-width, bidi overrides, other C0/C1); a stray `\r` is dropped,
 * turning CRLF into LF.
 */
const NormalizeMultilineText = () =>
  Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string'
      ? value
          .normalize('NFKC')
          .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' || ch === '\t' ? ch : ''))
          .trim()
      : value
  );

/** Payload for provisioning a new user record after OIDC sign-in. */
export class CreateUserDto {
  /** OIDC subject - used as the primary key. */
  @IsString()
  @IsNotEmpty()
  id!: string;

  /** Human-readable display name. */
  @NormalizeText()
  @IsString()
  @IsOptional()
  displayName?: string;

  /** EMSE graduation year (≥ 1816). */
  @IsInt()
  @Min(1816)
  @IsOptional()
  promo?: number;

  /** Given name. */
  @NormalizeText()
  @IsString()
  @IsOptional()
  firstName?: string;

  /** Family name. */
  @NormalizeText()
  @IsString()
  @IsOptional()
  lastName?: string;

  /** EMSE formation / track. */
  @NormalizeText()
  @IsString()
  @IsOptional()
  formation?: string;

  /** Stripe customer ID, set on first payment. */
  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}

/** Payload for updating mutable user profile fields. */
export class UpdateUserDto {
  /** Short user biography (max 500 chars). Multi-line: line breaks are preserved. */
  @NormalizeMultilineText()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  bio?: string;

  /** Stripe customer ID, updated when a new Stripe customer is created. */
  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}

/** Payload for updating the caller's private personal notepad. */
export class UpdateNotesDto {
  /** Markdown content of the personal notepad (max 50000 chars). */
  @IsString()
  @MaxLength(50000)
  @IsOptional()
  notes?: string;
}

/** Public-facing projection of a user - omits sensitive or internal fields. */
export class PublicUserDto {
  /** OIDC subject / primary key. */
  id?: string;
  /** Human-readable display name. */
  displayName?: string | null;
  /** Given name. */
  firstName?: string | null;
  /** Family name. */
  lastName?: string | null;
  /** EMSE graduation year. */
  promo?: number | null;
  /** EMSE formation / track. */
  formation?: string | null;
  /** Short biography. */
  bio?: string | null;
  /** Account creation timestamp. */
  createdAt?: Date;
  /** Whether the user has global admin privileges (only included in admin-facing responses). */
  admin?: boolean;
}

/** Query params for the public user directory search. */
export class DirectoryQueryDto {
  /** Name search (same semantics as `/users/search`). */
  @IsString()
  @IsOptional()
  @MaxLength(200)
  q?: string;

  /** Filter by EMSE promotion year. */
  @Type(() => Number)
  @IsInt()
  @Min(1816)
  @IsOptional()
  promo?: number;

  /** Filter by formation / cursus (substring, case-insensitive). */
  @IsString()
  @IsOptional()
  @MaxLength(120)
  formation?: string;

  /** Limit results to members of this association (social-service lookup). */
  @IsUUID()
  @IsOptional()
  associationId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  limit?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset?: number;
}

/** Row returned by the user directory search. */
export interface DirectoryUserRow {
  id: string;
  displayName: string | null;
  promo: number | null;
  formation: string | null;
  bio: string | null;
}
