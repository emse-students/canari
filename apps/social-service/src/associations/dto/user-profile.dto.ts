import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

/** Payload for adding a past association role to a user profile. */
export class CreateRoleHistoryDto {
  @IsUUID()
  associationId: string;

  @IsString()
  @MaxLength(120)
  roleTitle: string;

  @IsInt()
  @Min(1900)
  @IsOptional()
  startYear?: number;

  @IsInt()
  @Min(1900)
  @IsOptional()
  endYear?: number;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

/** Payload for updating a role history entry. */
export class UpdateRoleHistoryDto {
  @IsUUID()
  @IsOptional()
  associationId?: string;

  @IsString()
  @MaxLength(120)
  @IsOptional()
  roleTitle?: string;

  @IsInt()
  @Min(1900)
  @IsOptional()
  startYear?: number | null;

  @IsInt()
  @Min(1900)
  @IsOptional()
  endYear?: number | null;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}
