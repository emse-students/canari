import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** TypeORM entity representing a dynamic form, optionally linked to an association and Stripe payment. */
@Entity('forms')
export class Form {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  ownerId: string;

  @Column()
  title: string;

  @Column({ nullable: true })
  description: string;

  @Column({ default: 0 })
  basePrice: number;

  @Column({ default: 'eur' })
  currency: string;

  @Column({ default: 'Submit' })
  submitLabel: string;

  @Column({ nullable: true })
  maxSubmissions: number;

  /** When set, submissions are rejected until this instant (shotgun / scheduled opening). */
  @Column({ type: 'timestamptz', nullable: true })
  opensAt: Date | null;

  @Column({ default: false })
  requiresPayment: boolean;

  @Column('simple-array', { default: 'card' })
  paymentMethods: string[];

  @Column({ type: 'uuid', nullable: true })
  @Index()
  associationId: string;

  @Column('jsonb', { default: [] })
  items: any[];

  /**
   * When set, a paid submission grants (or renews) this tag to the submitter.
   * Format: `"<category>:<issuer-slug>-<year>"`, e.g. `"cotisant:bde-2026-2027"`.
   */
  @Column({ length: 100, nullable: true })
  grantedTagName: string | null;

  /** When the granted tag expires (null = permanent). */
  @Column({ type: 'timestamptz', nullable: true })
  tagExpiresAt: Date | null;

  /** Whether cash (physical) payment is accepted as an alternative to Stripe. */
  @Column({ default: false })
  allowCashPayment: boolean;

  /** Days after submission before an unvalidated cash payment expires (null = never). */
  @Column({ type: 'int', nullable: true })
  cashPaymentExpiryDays: number | null;

  /** Public URL of the form header/banner image (served via media-service). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  /** Internal media-service ID for the banner image (used for cleanup on update). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  imageMediaId: string | null;

  /** Additional user IDs that can manage this form and view submissions. */
  @Column('simple-array', { default: '' })
  coOwners: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
