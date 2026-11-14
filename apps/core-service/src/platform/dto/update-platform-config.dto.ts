import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RETENTION_SETTINGS, type RetentionKey } from '../retention';
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

/** The bounds of one retention setting - the same as its column's CHECK (migration 025). */
function bounds(key: RetentionKey): { minDays: number; maxDays: number } {
  const setting = RETENTION_SETTINGS.find((candidate) => candidate.key === key);
  if (!setting) throw new Error(`unknown retention setting ${key}`);
  return setting;
}

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

  /**
   * The retention durations in whole days (migration 025), each within its column's CHECK, so a
   * value Postgres would refuse as a 500 is a 400 here. Applied to content created from now on.
   */
  @IsOptional()
  @IsInt()
  @Min(bounds('retentionReelDays').minDays)
  @Max(bounds('retentionReelDays').maxDays)
  retentionReelDays?: number;

  @IsOptional()
  @IsInt()
  @Min(bounds('retentionLiveReplayDays').minDays)
  @Max(bounds('retentionLiveReplayDays').maxDays)
  retentionLiveReplayDays?: number;

  @IsOptional()
  @IsInt()
  @Min(bounds('retentionChatReelDays').minDays)
  @Max(bounds('retentionChatReelDays').maxDays)
  retentionChatReelDays?: number;

  @IsOptional()
  @IsInt()
  @Min(bounds('retentionIdleMediaDays').minDays)
  @Max(bounds('retentionIdleMediaDays').maxDays)
  retentionIdleMediaDays?: number;
}
