import {
  IsIn,
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
import { CAMPUSES, POSTS, type Campus, type CursusEntry, type Post } from '../miconnect-profile';

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
}

/**
 * Payload for updating mutable user profile fields.
 *
 * **`promo` and `formation` must never appear here.** They are written only by
 * `findOrCreateFromOidc`, from Authentik, at every sign-in - which is the reason a form's price grid
 * is allowed to rest on them (see the forms wiki page). Accepting either field from the user would
 * turn that grid into a self-service discount: the payer would move themselves into a cheaper cell.
 */
export class UpdateUserDto {
  /** Short user biography (max 500 chars). Multi-line: line breaks are preserved. */
  @NormalizeMultilineText()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  bio?: string;
}

/** Payload for updating the caller's private personal notepad. */
export class UpdateNotesDto {
  /**
   * AES-256-GCM ciphertext (base64) of the personal notepad. The server stores
   * it opaquely and never decrypts it. The bound is generous because base64 plus
   * the GCM envelope inflates the 50000-character plaintext limit by about a third.
   */
  @IsString()
  @MaxLength(100000)
  @IsOptional()
  ciphertext?: string;
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
  /** MiConnect campus. */
  campus?: Campus | null;
  /** MiConnect cursus: every formation the person follows or followed, with its entry year. */
  cursus?: CursusEntry[];
  /** MiConnect posts (EMSE, ME, ALUMNI). */
  posts?: Post[];
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

  /** Filter by MiConnect campus. */
  @IsIn(CAMPUSES)
  @IsOptional()
  campus?: Campus;

  /** Filter by MiConnect post. */
  @IsIn(POSTS)
  @IsOptional()
  post?: Post;

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
  campus: Campus | null;
  cursus: CursusEntry[];
  posts: Post[];
  bio: string | null;
}

/** DTO for blocking a person. */
export class BlockUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  userId!: string;
}
