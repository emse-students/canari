import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** TypeORM entity representing a student association with optional Stripe Connect integration. */
@Entity('associations')
export class Association {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  @Index()
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Public-facing markdown body (optional). */
  @Column({ type: 'text', nullable: true })
  bioMarkdown: string | null;

  @Column({ type: 'varchar', nullable: true })
  logoUrl: string | null;

  /** Media-service UUID for GET /api/media/public/:id (opaque blob in MinIO). */
  @Column({ type: 'uuid', nullable: true })
  logoMediaId: string | null;

  @Column({ type: 'varchar', nullable: true })
  stripeAccountId: string | null;

  @Column({ default: false })
  stripeOnboardingComplete: boolean;

  /**
   * When true, members of this association may use BDE-only flags
   * (VALIDATE_EVENTS, CREATE_ASSO, MODERATE). Set only by global admins.
   */
  @Column({ default: false })
  isBDE: boolean;

  /**
   * Hex-encoded 32-byte master key for the association's document vault.
   * Derived per-document via HKDF(vaultKey, salt=docId). Null until the first
   * document is uploaded (generated lazily).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  documentVaultKey: string | null;

  /**
   * Maximum total bytes the association may store in its document vault.
   * Default 500 MiB; adjustable by global admins.
   */
  @Column({ type: 'bigint', default: 524288000 })
  documentQuotaBytes: number;

  /** Hex color for calendar display (e.g. "#e83e8c"). Null → frontend falls back to generateAvatarColor. */
  @Column({ type: 'varchar', length: 7, nullable: true })
  color: string | null;

  /**
   * Discriminates a regular association from a promo "list". Lists behave like
   * associations (members, events) minus the banking/shop/vault features.
   */
  @Column({ type: 'varchar', length: 20, default: 'association' })
  type: 'association' | 'list';

  /** Lists only: the promotion year the list belongs to (e.g. 2027). Null for associations. */
  @Column({ type: 'int', nullable: true })
  promo: number | null;

  /** Lists only: optional parent association (e.g. the owning BDE). Null otherwise. */
  @Column({ type: 'uuid', nullable: true })
  parentAssociationId: string | null;

  /** When true, the association is archived: shown under "Anciennes", hidden from "Mes associations". */
  @Column({ default: false })
  archived: boolean;

  /** Public contact e-mail, shown on the trombinoscope export and the association page. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  contactEmail: string | null;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
