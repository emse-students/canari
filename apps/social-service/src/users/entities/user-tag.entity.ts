import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, Unique } from 'typeorm';

/**
 * Cotisation/membership tag granted to a user by an association.
 * Upserted on `(userId, tagName)` - a second grant extends `expiresAt` rather than creating a duplicate.
 */
@Entity('user_tags')
@Unique(['userId', 'tagName'])
export class UserTag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The user who holds this tag. */
  @Column()
  @Index()
  userId: string;

  /**
   * Structured tag name, e.g. `"cotisant:bde-2026-2027"`.
   * Convention: `"<category>:<issuer-slug>-<year>"`.
   */
  @Column({ length: 100 })
  tagName: string;

  /** Association that issued the tag (null for system-granted tags). */
  @Column({ type: 'uuid', nullable: true })
  issuingAssocId: string | null;

  /** userId of the admin who granted it, or `'system'` for automated grants. */
  @Column()
  grantedBy: string;

  /** When the tag expires (null = permanent). */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Arbitrary metadata (e.g. stripe payment intent, form submission id). */
  @Column({ type: 'jsonb', default: '{}' })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
