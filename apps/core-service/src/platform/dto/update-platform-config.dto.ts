import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CALLS_MODES, type CallsMode } from '../entities/platform-config.entity';

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

  @IsOptional()
  @IsIn(['lydia', 'disabled'])
  paymentProvider?: 'lydia' | 'disabled';

  /** The calls kill switch: `off` refuses every call, `audio` refuses video, `audio_video` allows both. */
  @IsOptional()
  @IsIn(CALLS_MODES)
  callsMode?: CallsMode;
}
