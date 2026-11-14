import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Singleton row (id=1) holding platform-wide settings toggled by global admins. */
@Entity('platform_config')
export class PlatformConfig {
  @PrimaryColumn({ type: 'int', default: 1 })
  id!: number;

  /** When true, only global admins may authenticate and use authenticated APIs. */
  @Column({ name: 'maintenance_enabled', type: 'boolean', default: false })
  maintenanceEnabled!: boolean;

  /** Optional message shown to users blocked by maintenance mode. */
  @Column({ name: 'maintenance_message', type: 'text', nullable: true })
  maintenanceMessage!: string | null;

  /** Minimum client semver required before MLS unlock (major.minor.patch). */
  @Column({
    name: 'min_client_version',
    type: 'varchar',
    length: 32,
    default: '0.0.0',
  })
  minClientVersion!: string;

  /** Which payment provider PaymentService routes to (WP-LYDIA-1). Admin-editable, no restart needed.
   *  'disabled' (9 chars, fits VARCHAR(16): no migration) turns every checkout and onboarding off. */
  @Column({
    name: 'payment_provider',
    type: 'varchar',
    length: 16,
    default: 'disabled',
  })
  paymentProvider!: 'lydia' | 'disabled';

  /** The server's kill switch for calls (migration 014): which calls may start on this estate. */
  @Column({
    name: 'calls_mode',
    type: 'varchar',
    length: 16,
    default: 'off',
  })
  callsMode!: CallsMode;

  /** The server's kill switch for lives (migration 015): whether the live routes may answer. */
  @Column({
    name: 'lives_mode',
    type: 'varchar',
    length: 16,
    default: 'off',
  })
  livesMode!: LivesMode;

  /**
   * What an MLS push tells Google and Apple (migration 018): today's payloads, or a content-free
   * wake-up the device completes from this estate.
   */
  @Column({
    name: 'push_mode',
    type: 'varchar',
    length: 16,
    default: 'full',
  })
  pushMode!: PushMode;

  /**
   * Whether a client may skip the MLS checkpoint after a drain that only received application
   * frames (migration 020, WP-CHECKPOINT-SKIP). Read by no service: published by `GET /api/version`.
   */
  @Column({
    name: 'checkpoint_skip_mode',
    type: 'varchar',
    length: 16,
    default: 'off',
  })
  checkpointSkipMode!: CheckpointSkipMode;

  /**
   * Whether a live started now keeps a three-day replay (migration 021, WP-R1 of the live replays).
   * Read by social-service at a live's start and fixed on the live row; published by `GET /api/version`.
   */
  @Column({
    name: 'live_replays_mode',
    type: 'varchar',
    length: 16,
    default: 'off',
  })
  liveReplaysMode!: LiveReplaysMode;

  /**
   * Whether a group conversation may hold a call (migration 022). Read by chat-delivery-service at
   * `initiate`; published by `GET /api/version` as `calls.groupMode`. `calls_mode = off` still wins.
   */
  @Column({
    name: 'group_calls_mode',
    type: 'varchar',
    length: 16,
    default: 'off',
  })
  groupCallsMode!: GroupCallsMode;

  /**
   * Which relay carries a group call (migration 023, WP-GC4). Read by chat-delivery-service at a
   * group call's `initiate`; published by `GET /api/version` as `calls.relay`.
   */
  @Column({
    name: 'call_relay',
    type: 'varchar',
    length: 16,
    default: 'none',
  })
  callRelay!: CallRelay;

  /**
   * The date every Lydia contract year starts on (migration 024), `YYYY-MM-DD`; NULL = not
   * configured. Read by `LydiaContractService` only, never published (docs/wiki/lydia-contract-flux.md).
   */
  @Column({ name: 'lydia_contract_anniversary', type: 'date', nullable: true })
  lydiaContractAnniversary!: string | null;

  /**
   * The rest of the Lydia contract terms (migration 024): `LydiaContractTerms`, validated by
   * `parseLydiaContractTerms` on every write and read; NULL = nothing entered. Confidential: read by
   * `LydiaContractService` only, never published.
   */
  @Column({ name: 'lydia_contract', type: 'jsonb', nullable: true })
  lydiaContract!: unknown;

  /**
   * The retention durations, in days (migration 025, `../retention.ts`): read at the CREATION of each
   * item by the service that stamps its expiry, so a change applies to new content only. Published by
   * `GET /api/version` as `retention`, which the privacy policy renders.
   */
  @Column({ name: 'retention_reel_days', type: 'int', default: 365 })
  retentionReelDays!: number;

  /** See {@link retentionReelDays}: a live replay, from the live's end. */
  @Column({ name: 'retention_live_replay_days', type: 'int', default: 3 })
  retentionLiveReplayDays!: number;

  /** See {@link retentionReelDays}: a CanaReel sent in a conversation, from its upload or hold. */
  @Column({ name: 'retention_chat_reel_days', type: 'int', default: 30 })
  retentionChatReelDays!: number;

  /** See {@link retentionReelDays}: a file sent in a conversation, from its last download. */
  @Column({ name: 'retention_idle_media_days', type: 'int', default: 90 })
  retentionIdleMediaDays!: number;
}

/**
 * Which calls an estate lets start. `off` refuses every call request; `audio` refuses a ring that
 * asks for video; `audio_video` allows both. Read by chat-delivery-service on every call request
 * (`apps/chat-delivery-service/src/utils/calls-mode.ts`, the same three values, held together by the
 * column's CHECK constraint) and published to clients by `GET /api/version`.
 */
export type CallsMode = 'off' | 'audio' | 'audio_video';

/** Every {@link CallsMode}, for the DTO's validation. */
export const CALLS_MODES: readonly CallsMode[] = ['off', 'audio', 'audio_video'];

/**
 * Whether an estate lets lives answer. `off` makes every live route answer 404, as the
 * `LIVE_ENABLED` deploy lock does; `on` lets them answer PROVIDED that lock is on too - the two are
 * ANDed. Read by social-service on every live request (`apps/social-service/src/lives/lives-mode.ts`,
 * the same two values, held together by the column's CHECK constraint), relayed by it to
 * media-service's segment routes, and published to clients by `GET /api/version`.
 */
export type LivesMode = 'off' | 'on';

/** Every {@link LivesMode}, for the DTO's validation. */
export const LIVES_MODES: readonly LivesMode[] = ['off', 'on'];

/**
 * What an MLS push carries. `full` is today's payload (conversation and sender ids, the names on a
 * visible frame, the inline ciphertext); `wake` sends a device that declared it understands one only
 * `type`, `queuedMessageId` and `silent`, and the device fetches the rest from this estate
 * (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md). Read by
 * chat-delivery-service on every MLS push with a capable destination
 * (`apps/chat-delivery-service/src/utils/push-mode.ts`, the same two values, held together by the
 * column's CHECK constraint). Not published to clients: the push itself says which shape it is.
 */
export type PushMode = 'full' | 'wake';

/** Every {@link PushMode}, for the DTO's validation. */
export const PUSH_MODES: readonly PushMode[] = ['full', 'wake'];

/**
 * Whether an estate's clients may skip the full MLS checkpoint after a live drain that only received
 * application frames. `off` is today's behaviour (every drain checkpoints); `on` lets a client leave
 * that checkpoint to the next existing trigger until 100 receive generations are unsaved - the count
 * is the client's (`frontend/src/lib/mls-client/receiveCheckpointSkip.ts`, the same two values, held
 * together by the column's CHECK constraint). Published to clients by `GET /api/version`; no service
 * reads it.
 */
export type CheckpointSkipMode = 'off' | 'on';

/** Every {@link CheckpointSkipMode}, for the DTO's validation. */
export const CHECKPOINT_SKIP_MODES: readonly CheckpointSkipMode[] = ['off', 'on'];

/**
 * Whether a finished live is kept three days as a replay (docs/wiki/live-replays.md). `off` is today's
 * behaviour (a live is deleted at its end); `on` makes every live STARTED while it holds keep its last
 * three hours and publish a replay at its end. Read by social-service at the start
 * (`lives/live-replays-mode.ts`, the same two values, held together by the column's CHECK and
 * `liveReplaysModesAgree.test.ts`).
 */
export type LiveReplaysMode = 'off' | 'on';

/** Every {@link LiveReplaysMode}, for the DTO's validation. */
export const LIVE_REPLAYS_MODES: readonly LiveReplaysMode[] = ['off', 'on'];

/**
 * Whether a group conversation may hold a call (owner decision D-A). `off` refuses every group
 * `initiate` (403 `GROUP_CALLS_DISABLED`); `mesh` allows peer-to-peer group calls up to 4 participants
 * in audio and 3 in video. Read by chat-delivery-service at `initiate`, held together with the column's
 * CHECK and the frontend by `groupCallsModesAgree.test.ts`. `callsMode = off` still closes everything.
 */
export type GroupCallsMode = 'off' | 'mesh';

/** Every {@link GroupCallsMode}, for the DTO's validation. */
export const GROUP_CALLS_MODES: readonly GroupCallsMode[] = ['off', 'mesh'];

/**
 * Which relay carries a group call (owner decision D2). `none`: the mesh, and the participant past
 * its cap is refused; `call-service`: our Rust SFU carries the group call from the start (interim,
 * until WP-GC5's mid-call switch). Held together with the column's CHECK, chat-delivery's reader and
 * the frontend by `callRelaysAgree.test.ts`. `cloudflare` joins when its leg is built.
 */
export type CallRelay = 'none' | 'call-service';

/** Every {@link CallRelay}, for the DTO's validation. */
export const CALL_RELAYS: readonly CallRelay[] = ['none', 'call-service'];
