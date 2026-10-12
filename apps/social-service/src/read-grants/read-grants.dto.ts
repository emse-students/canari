import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SPACE_CAMPUSES, SPACE_FORMATIONS } from '../spaces/space.entity';
import type { SpaceCampus, SpaceFormation } from '../spaces/space.entity';

/**
 * Sets ONE cell of the grid for ONE named account: grant it (`granted: true`) or revoke it. Setting
 * a state rather than toggling keeps a double click, a retry and two admins idempotent.
 */
export class SetReadGrantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  userId!: string;

  @IsIn(SPACE_CAMPUSES)
  campus!: SpaceCampus;

  /** Absent or `null` is "the whole campus". */
  @IsOptional()
  @IsIn(SPACE_FORMATIONS)
  formation?: SpaceFormation | null;

  @IsBoolean()
  granted!: boolean;
}
