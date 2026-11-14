import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** Platform that issued the push token - determines which push gateway is used for delivery. */
export type PushPlatform = 'android' | 'ios';

/**
 * Stores the FCM (Android) or APNs (iOS) push notification token for a device so
 * that the server can wake the app when a new message arrives while it is in the
 * background. There is at most one active token per (userId, deviceId) pair;
 * re-registering replaces the existing row.
 */
@Entity()
@Index(['userId', 'deviceId'], { unique: true })
export class PushToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** User who owns the device. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Opaque client-generated device identifier. */
  @Column()
  deviceId: string;

  /** Raw FCM registration token or APNs device token supplied by the OS. */
  @Column()
  token: string;

  /** Push gateway to use: `android` (FCM) or `ios` (APNs). */
  @Column({ type: 'varchar', length: 10 })
  platform: PushPlatform;

  /**
   * Opaque secret (UUID v4) generated at registration and returned to the client
   * exactly once. The Android client stores it encrypted in the system Keystore.
   * Used to authenticate `GET /api/mls/push/fetch-proto` without a JWT so that the
   * app can fetch the pending proto payload in a background push handler. The raw
   * value is stored in this table (access is internal only). Null for legacy tokens
   * registered before this field was introduced.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  pushSecret: string | null;

  /**
   * PushKit VoIP token (iOS only, WP-XP-5). Registered by the native PKPushRegistry
   * callback via `POST /mls/push/refresh-token`. When present, incoming-call rings are
   * delivered as direct APNs VoIP pushes (CallKit); when null the device falls back to
   * a regular FCM alert push. Always null on Android.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  voipToken: string | null;

  /**
   * The language this device reads, as the app knows it - not as a header or an IP suggests.
   *
   * It exists for exactly one sentence: `APNS_FALLBACK_BODY`, the alert an iPhone shows when the
   * Notification Service Extension does not run or cannot decrypt. Every other sentence on this
   * path is composed BY the device, which is why no other column like this exists and why this one
   * must not grow readers - the server is the layer that cannot know who is reading, and a second
   * server-composed sentence is a defect before it is a translation.
   *
   * Null means "not told", and reads as the base locale. Written by `POST /mls/push/register`,
   * which the client re-issues on a language change because its skip predicate keys on the token
   * AND the locale.
   */
  @Column({ type: 'varchar', length: 5, nullable: true })
  locale: string | null;

  /**
   * The core-service session whose access token made this registration (migration 037) - the `sid`
   * claim, forwarded by nginx as `X-Session-Id`. Ending that session deletes exactly this row
   * (`DELETE /api/internal/push/users/:userId/sessions/:sessionId`), so a later
   * registration by a re-sign-in on the same device, which rewrites it, is never removed by the old
   * session's end.
   *
   * Null for a row registered before the column existed, or with an access token minted before the
   * claim did; such a row is rewritten at the device's next registration, with no backfill.
   */
  @Column({ type: 'uuid', nullable: true })
  sessionId: string | null;

  /**
   * Whether this device's binary understands a content-free wake-up push (migration 045).
   *
   * Written on EVERY `POST /mls/push/register`, false unless the body says `wake: true`: an old build
   * and a downgrade are never sent a frame they would drop.
   *
   * NO LONGER READ by this server: `wakeVersion` replaced it (migration 046). Still written
   * (`wakeVersion >= 1`) so a rollback to a release that reads it sends the same pushes; dropped by
   * its own held migration once no shipped server reads it (content-free push WP-W3c).
   */
  @Column({ type: 'boolean', default: false })
  wakeCapable: boolean;

  /**
   * Which content-free wake this device's binary understands (migration 046): 0 none, 1 the MLS
   * frame wake (what `wakeCapable = true` says), 2 the envelope wake too (`push_envelope`). The
   * versions are cumulative - a binary at 2 understands 1.
   *
   * Written on EVERY `POST /mls/push/register`, 0 unless the body says otherwise. The ONE reader of
   * the capability: an MLS frame is sent as a wake at `>= 1`, a `sendPushToUser` push at `>= 2`,
   * both only while `platform_config.push_mode = 'wake'`. `wakeCapable` is still written beside it,
   * for a rollback to a server that reads it, until its own held migration drops it (WP-W3c).
   */
  @Column({ type: 'integer', default: 0 })
  wakeVersion: number;

  /**
   * Which GROUP call this device's binary can take part in (migration 050, WP-GC2): 0 none, 1 the
   * peer-to-peer mesh (`GROUP_CALL_MESH_VERSION`). Written on EVERY `POST /mls/push/register`, 0
   * unless the body says otherwise. Its ONE reader: a group call's ring is pushed only to devices at
   * `>= 1`, so an old binary is never rung for a call it would join as a 1:1 call.
   */
  @Column({ type: 'integer', default: 0 })
  groupCallVersion: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
