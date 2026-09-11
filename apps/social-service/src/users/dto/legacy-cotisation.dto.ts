import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { LegacyCotisationStatus } from '../legacy-cotisation.service';

/** Query parameters of the read-only legacy-cotisation staging listing. */
export class ListLegacyCotisationsQueryDto {
  /** Which slice to return; defaults to every row. */
  @IsOptional()
  @IsIn(['all', 'pending', 'claimed', 'collisions'])
  status?: LegacyCotisationStatus;

  /** Case-insensitive substring match on the source's own spelling AND on the normalized key. */
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
