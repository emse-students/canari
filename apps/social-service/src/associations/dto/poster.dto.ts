import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** Payload for creating a poster project. `layout` defaults to an empty document. */
export class CreatePosterProjectDto {
  @IsString()
  @MaxLength(120)
  name: string;

  /** Opaque layout document (bubbles / doodles / texts / theme / background). */
  @IsObject()
  @IsOptional()
  layout?: Record<string, unknown>;
}

/** Partial update of a poster project (rename and/or replace the layout). */
export class UpdatePosterProjectDto {
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @IsObject()
  @IsOptional()
  layout?: Record<string, unknown>;
}
