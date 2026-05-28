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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
