import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import {
  CALLS_MODES,
  LIVES_MODES,
  PUSH_MODES,
  type CallsMode,
  type LivesMode,
  type PushMode,
} from '../entities/platform-config.entity';

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

  /** The lives kill switch: `off` makes every live route answer 404, `on` lets them answer. */
  @IsOptional()
  @IsIn(LIVES_MODES)
  livesMode?: LivesMode;

  /** The push switch: `full` sends today's payloads, `wake` a content-free wake-up to capable devices. */
  @IsOptional()
  @IsIn(PUSH_MODES)
  pushMode?: PushMode;
}
