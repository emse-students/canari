import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** Payload for provisioning a new user record after OIDC sign-in. */
export class CreateUserDto {
  /** OIDC subject — used as the primary key. */
  @IsString()
  @IsNotEmpty()
  id!: string;

  /** Human-readable display name. */
  @IsString()
  @IsOptional()
  displayName?: string;

  /** EMSE graduation year (≥ 1816). */
  @IsInt()
  @Min(1816)
  @IsOptional()
  promo?: number;

  /** Given name. */
  @IsString()
  @IsOptional()
  firstName?: string;

  /** Family name. */
  @IsString()
  @IsOptional()
  lastName?: string;

  /** EMSE formation / track. */
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
  /** Short user biography (max 500 chars). */
  @IsString()
  @MaxLength(500)
  @IsOptional()
  bio?: string;

  /** Stripe customer ID, updated when a new Stripe customer is created. */
  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}

/** Public-facing projection of a user — omits sensitive or internal fields. */
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
