import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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

/** Payload replacing the audience rules of an association: at least one, at most sixteen. */
export class SetAudiencesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => AudienceRuleDto)
  rules!: AudienceRuleDto[];
}
