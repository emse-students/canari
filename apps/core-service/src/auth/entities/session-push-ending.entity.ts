import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One push-registration ending still owed to an ended session: the outbox row (migration 016).
 * `SessionPushEndService` owns every write - the insert in the transaction that deletes the session,
 * the claim, the retry state, and the delete once chat-delivery-service answered 2xx. This class
 * exists so the table is registered (and created by `synchronize` outside production).
 */
@Entity('session_push_endings')
@Index('IDX_session_push_endings_due', ['nextAttemptAt'])
export class SessionPushEnding {
  /** The ended session (`auth_sessions.id`). A session ends once, so it is the key. */
  @PrimaryColumn('uuid')
  sessionId!: string;

  @Column({ type: 'varchar', length: 255 })
  userId!: string;

  @Column({ type: 'varchar', length: 128 })
  deviceId!: string;

  /** Why the session ended (`logout`, `revoked-by-owner`, `revoked-others`, `replay`), for the log. */
  @Column({ type: 'varchar', length: 32 })
  cause!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  /** Failed attempts so far. */
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** When the row may be claimed next: a lease while a call runs, a backoff after a failure. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;
}
