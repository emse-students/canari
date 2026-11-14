import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import {
  CALLS_MODES,
  CALL_RELAYS,
  CHECKPOINT_SKIP_MODES,
  GROUP_CALLS_MODES,
  LIVES_MODES,
  LIVE_REPLAYS_MODES,
  PUSH_MODES,
  type CallRelay,
  type CallsMode,
  type CheckpointSkipMode,
  type GroupCallsMode,
  type LivesMode,
  type LiveReplaysMode,
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

  /** The checkpoint-skip switch: `off` checkpoints every drain, `on` lets a receive-only drain defer it. */
  @IsOptional()
  @IsIn(CHECKPOINT_SKIP_MODES)
  checkpointSkipMode?: CheckpointSkipMode;

  /** The live replays switch: `off` deletes a live at its end, `on` keeps a live started now three days. */
  @IsOptional()
  @IsIn(LIVE_REPLAYS_MODES)
  liveReplaysMode?: LiveReplaysMode;

  /** The group calls switch: `off` refuses every group call, `mesh` allows peer-to-peer ones up to the cap. */
  @IsOptional()
  @IsIn(GROUP_CALLS_MODES)
  groupCallsMode?: GroupCallsMode;

  /** Which relay carries a group call: `none` (the mesh only) or `call-service` (our SFU). */
  @IsOptional()
  @IsIn(CALL_RELAYS)
  callRelay?: CallRelay;
}
