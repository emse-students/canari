import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A session an owner's device revocation ended (migration 017) - the record that lets the refresh
 * refusal say WHY the session is gone (`DEVICE_REVOKED_BY_OWNER`), since the session row itself is
 * deleted. `AuthSessionsService` owns every write: the insert in the transaction that ends the
 * device's sessions, the read on a refused refresh, and the sweep once no refresh token naming the
 * session can still verify. This class exists so the table is registered (and created by
 * `synchronize` outside production).
 */
@Entity('device_revoked_sessions')
@Index('IDX_device_revoked_sessions_ended', ['endedAt'])
export class DeviceRevokedSession {
  /** The ended session (`auth_sessions.id`). A session ends once, so it is the key. */
  @PrimaryColumn('uuid')
  sessionId!: string;

  @Column({ type: 'varchar', length: 255 })
  userId!: string;

  /** The revoked device the session was bound to. */
  @Column({ type: 'varchar', length: 128 })
  deviceId!: string;

  /** When the revocation ended the session; the sweep's bound is this plus one refresh-token life. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  endedAt!: Date;
}
