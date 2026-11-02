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
