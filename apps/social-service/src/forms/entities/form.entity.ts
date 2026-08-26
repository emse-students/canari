import type { AudienceCondition } from '../pricing/audience';
import type { PriceMatrix } from '../pricing/price-matrix';
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

  @Column({ nullable: true })
  maxSubmissions: number;

  /** When set, submissions are rejected until this instant (shotgun / scheduled opening). */
  @Column({ type: 'timestamptz', nullable: true })
  opensAt: Date | null;

  /** When set, submissions are rejected after this instant (automatic form closure). */
  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

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
   * The pricing grid: the criteria this form discriminates on, and one price per combination.
   * NULL means one price for everybody, `basePrice`.
   *
   * A MATRIX rather than an ordered list of price rules, which is the user's own correction and the
   * reason this feature has no priority rule: the cells partition the population, so exactly one
   * applies to anybody. Completeness is a save-time invariant (`assertMatrixValid`), and the
   * "everyone else" bucket of each dimension is GENERATED, never stored - which is what guarantees
   * no submitter is ever unpriced. See migration 051 and `pricing/price-matrix.ts`.
   *
   * A cell is the BASE price for its combination: a question used as a criterion contributes no
   * additive option modifier, or the same choice would be charged twice.
   */
  @Column('jsonb', { nullable: true })
  priceMatrix: PriceMatrix | null;

  /**
   * Who may submit at all - the same bucket predicate the grid is built from, AND-ed across the
   * criteria present. NULL means anybody may.
   *
   * Enforced in `submit`, not only by hiding the form: a form that is not offered is not a form
   * that is closed.
   */
  @Column('jsonb', { nullable: true })
  submitCondition: AudienceCondition | null;

  /**
   * When true, a paid submission grants (or renews) `associationId`'s cotisation to the submitter,
   * through the same `grantCotisant` path as a boutique purchase or a manual add - so the tag is
   * derived at grant time and the sibling-tier XOR is enforced.
   *
   * A boolean is required because `cotisationVariantKey: null` is the BASE tier, not "no grant"
   * (migration 050).
   */
  @Column({ default: false })
  grantsCotisation: boolean;

  /**
   * Which tier `grantsCotisation` grants. NULL = the base, un-suffixed tier, matching
   * `grantCotisant`'s own `variantKey` parameter. Meaningless when `grantsCotisation` is false.
   *
   * This stores the REFERENCE, never the resulting tag: a stored tag string would keep granting
   * last academic year's cotisation forever (migration 050).
   */
  @Column({ length: 100, nullable: true })
  cotisationVariantKey: string | null;

  /** When true, a user can submit the form multiple times (e.g. product orders). */
  @Column({ default: false })
  allowMultipleSubmissions: boolean;

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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
