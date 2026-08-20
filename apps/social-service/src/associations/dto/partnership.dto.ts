import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import type { PartnershipClaimMode } from '../entities/partnership-card.entity';

const CLAIM_MODES: PartnershipClaimMode[] = ['code_pool', 'shared_code', 'text'];

/**
 * DTO for creating a partnership card. `sharedCode`/`staticText` are validated only when
 * `claimMode` requires them; `PartnershipsService.assertModeShape` additionally rejects the
 * field belonging to a DIFFERENT mode being set, which `@ValidateIf` alone can't express.
 * Deliberately has no `codes` field - codes are added via a separate bulk-add endpoint once the
 * card exists.
 */
export class CreatePartnershipCardDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsUrl()
  @IsOptional()
  @MaxLength(500)
  link?: string;

  @IsIn(CLAIM_MODES)
  claimMode: PartnershipClaimMode;

  @ValidateIf((o) => o.claimMode === 'shared_code')
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sharedCode?: string;

  @ValidateIf((o) => o.claimMode === 'text')
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  staticText?: string;

  /** Reserved to holders of the association's active cotisation tag. */
  @IsBoolean()
  @IsOptional()
  membersOnly?: boolean;
}

/**
 * DTO for partial updates to a partnership card. `claimMode` is intentionally absent: changing
 * mode after creation is disallowed (delete and recreate instead) since existing claims would
 * otherwise need to be migrated.
 */
export class UpdatePartnershipCardDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsUrl()
  @IsOptional()
  @MaxLength(500)
  link?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  sharedCode?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  staticText?: string;

  @IsBoolean()
  @IsOptional()
  membersOnly?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/** DTO for bulk-adding codes to a `code_pool` card. Already-stored codes are silently skipped. */
export class AddPartnershipCodesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  codes: string[];
}
