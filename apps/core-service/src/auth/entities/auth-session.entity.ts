import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One row per long-lived login (one browser, one phone, one desktop app).
 *
 * The access token stays stateless - six services and the nginx `auth_request`
 * verify it without touching a database - so this row backs the REFRESH token
 * only. It is what makes revocation possible at all: before it existed, a
 * refresh token was a self-describing 7-day bearer credential that `logout`
 * could not invalidate and that minted a fresh 7 days on every use.
 *
 * The refresh JWT carries `sid` (this row's {@link id}) and `jti` (its current
 * {@link tokenId}). Presenting a `jti` that is not the current one means two
 * holders share one cookie, which is a theft signal - see
 * `AuthSessionsService.rotate`.
 */
@Entity('auth_sessions')
export class AuthSession {
  /**
   * Session id, carried as `sid` in the refresh JWT. Stable across rotations.
   *
   * Generated in Node rather than by the database: a `PrimaryGeneratedColumn`
   * would make TypeORM's dev-time `synchronize` emit `uuid_generate_v4()` and
   * require the `uuid-ossp` extension, so dev and production would need
   * different database setups to create the same table.
   */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** Owner (`users.id`, an OIDC sub). Rows die with the account (FK ON DELETE CASCADE). */
  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId!: string;

  /**
   * The only refresh token id currently accepted for this session, carried as
   * `jti`. Rotated on every successful refresh.
   */
  @Column({ type: 'uuid' })
  tokenId!: string;

  /**
   * The `jti` replaced by the last rotation, accepted for
   * `ROTATION_GRACE_SECONDS` after {@link rotatedAt}.
   *
   * Without it, two tabs refreshing at once would be indistinguishable from a
   * stolen cookie: one wins the rotation, the other presents a token that is
   * one generation old, and the session gets revoked on a race the user caused
   * by opening a second tab.
   */
  @Column({ type: 'uuid', nullable: true })
  previousTokenId?: string | null;

  /** When {@link previousTokenId} was superseded - the start of its grace window. */
  @Column({ type: 'timestamptz', nullable: true })
  rotatedAt?: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  /** Last successful refresh. Shown in the UI as "last active". */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastUsedAt!: Date;

  /** Idle deadline, pushed forward by each rotation. A row past it is dead even if it is still stored. */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Raw User-Agent of the last refresh, truncated. Only ever displayed to the session's owner. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent?: string | null;

  /**
   * Client IP of the last refresh. It exists so the owner can recognise a
   * session that is not theirs; it is never used for authorization, and it
   * disappears with the row (7 days idle at most).
   */
  @Column({ type: 'varchar', length: 45, nullable: true })
  lastIp?: string | null;
}
