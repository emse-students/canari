import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One Android restore key: the public half of a WebAuthn credential the phone's Credential Manager
 * created for this app and backed up with the phone (docs/wiki/account-restore.md).
 *
 * BOUND TO THE SESSION THAT REGISTERED IT: `sessionId` cascades from `auth_sessions`
 * (migration 013), so the key dies with that session, whatever ends it. One key per session.
 */
@Entity('restore_credentials')
export class RestoreCredential {
  /** The credential id, base64url, exactly as the platform names it. */
  @PrimaryColumn({ type: 'text' })
  id!: string;

  /** The account (`users.id`). Deleted by name at account erasure, and FK ON DELETE CASCADE. */
  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId!: string;

  /** The session that registered the key. UNIQUE, FK ON DELETE CASCADE - the invariant. */
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  sessionId!: string;

  /** COSE public key. The private half never leaves the phone's platform. */
  @Column({ type: 'bytea' })
  publicKey!: Buffer;

  /** Signature counter at registration. A key is used once (a restore consumes it), so it never moves. */
  @Column({ type: 'bigint', default: 0 })
  counter!: string;

  /** True when the phone backed the key up to Google; false on the E2eeUnavailable second path. */
  @Column({ type: 'boolean' })
  cloudBackup!: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}

/**
 * A restore challenge already answered by a verified assertion. Written ONLY after the signature
 * verified, so an anonymous caller cannot grow this table; swept once past `expiresAt`, after which
 * the challenge itself is refused as expired anyway.
 */
@Entity('restore_challenges_spent')
export class RestoreChallengeSpent {
  @PrimaryColumn({ type: 'text' })
  nonce!: string;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;
}
