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

  @Column({ type: 'varchar', length: 255 })
  @Index()
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
