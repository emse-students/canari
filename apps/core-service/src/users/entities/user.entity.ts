import { Entity, Column, PrimaryColumn } from 'typeorm';

/** TypeORM entity representing a Canari user, keyed by their OIDC subject. */
@Entity('users')
export class User {
  /** OIDC `sub` - not necessarily a UUID string. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  displayName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  firstName?: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastName?: string | null;

  @Column({ type: 'int', nullable: true })
  promo?: number | null;

  @Column({ type: 'varchar', nullable: true })
  formation?: string | null;

  @Column({ type: 'text', nullable: true })
  bio?: string | null;

  /**
   * Legacy plaintext personal notepad. Read-only now: it exists so a note written
   * before the notepad was encrypted can be handed back once, re-encrypted by the
   * client and cleared. Never exposed in public projections.
   */
  @Column({ type: 'text', nullable: true })
  notes?: string | null;

  /**
   * Personal notepad as opaque AES-256-GCM ciphertext (base64), encrypted and
   * decrypted by the client. Same shape as an association's `notesCiphertext`.
   */
  @Column({ type: 'text', nullable: true })
  notesCiphertext?: string | null;

  /**
   * Per-user key for {@link notesCiphertext}, 32 bytes hex, generated on first
   * use and served only to the owner. It keeps the notepad unreadable in a
   * database dump; it is deliberately NOT zero-knowledge, so a forgotten PIN
   * never costs the user their notes.
   */
  @Column({ type: 'varchar', nullable: true })
  notesKey?: string | null;

  @Column({ type: 'varchar', nullable: true })
  stripeCustomerId?: string | null;

  @Column({ type: 'boolean', default: false })
  admin?: boolean;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt?: Date;

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt?: Date;
}
