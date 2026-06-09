import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Body for PATCH /api/users/admin/platform - partial platform settings update. */
export class UpdatePlatformConfigDto {
  @IsOptional()
  @IsBoolean()
  maintenanceEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  maintenanceMessage?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d+\.\d+\.\d+$/, {
    message: 'minClientVersion must be a semver major.minor.patch string',
  })
  minClientVersion?: string;
}
