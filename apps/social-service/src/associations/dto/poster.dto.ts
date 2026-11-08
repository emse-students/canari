import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Payload for creating a poster project. `layout` defaults to an empty document.
 *
 * `spaceId` names the space the map is drawn for (owner, 2026-11-08) and is required: a map belongs
 * to one space from its creation, and the caller must manage that space (`poster-scope.ts`).
 */
export class CreatePosterProjectDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsUUID()
  spaceId: string;

  /** Opaque layout document (bubbles / doodles / texts / theme / background). */
  @IsObject()
  @IsOptional()
  layout?: Record<string, unknown>;
}

/**
 * Partial update of a poster project: rename, replace the layout, or ATTACH a map that has no space
 * (a map left unattached by migration 147). An attached map never changes space.
 */
export class UpdatePosterProjectDto {
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @IsObject()
  @IsOptional()
  layout?: Record<string, unknown>;

  @IsUUID()
  @IsOptional()
  spaceId?: string;
}

/** A zone's label, on creation or rename. */
export class PosterZoneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;
}

/** The map's zones, top to bottom: every zone of the map, each exactly once. */
export class ReorderPosterZonesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  orderedIds: string[];
}

/** One association's switch and zone on a map; an absent field is left as it is. */
export class PosterEntryDto {
  @IsUUID()
  associationId: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  /** A zone of this map, or null to unzone. */
  @IsOptional()
  @IsUUID()
  zoneId?: string | null;
}

/** Several switches at once - one toggle, or "mark every new association as seen". */
export class SetPosterEntriesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PosterEntryDto)
  entries: PosterEntryDto[];
}
