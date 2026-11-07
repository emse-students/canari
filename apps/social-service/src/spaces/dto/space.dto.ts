import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { SPACE_CAMPUSES, SPACE_FORMATIONS } from '../space.entity';
import type { SpaceCampus, SpaceFormation } from '../space.entity';

/** Payload to designate (or clear, with `null`) the BDE of a space (D22). */
export class SetSpaceBdeDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  associationId!: string | null;
}

/** One audience rule; `null` or absent means "any" (see `AssociationAudience`). */
export class AudienceRuleDto {
  @IsOptional()
  @IsIn(SPACE_FORMATIONS)
  formation?: SpaceFormation | null;

  @IsOptional()
  @IsIn(SPACE_CAMPUSES)
  campus?: SpaceCampus | null;
}

/** Payload replacing the audience rules of an association: none (it reaches nobody) to sixteen. */
export class SetAudiencesDto {
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => AudienceRuleDto)
  rules!: AudienceRuleDto[];
}

/**
 * Payload setting the governing parent of an association or a list (WP-D1, reform 2.7; platform
 * admin only): `parentAssociationId` a BDE or `null` (none); `displayParentAssociationId` the G3
 * label, `null` to clear it, absent to leave it.
 */
export class SetDependencyDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentAssociationId!: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  displayParentAssociationId?: string | null;
}
