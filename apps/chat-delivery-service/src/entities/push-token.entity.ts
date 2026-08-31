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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
