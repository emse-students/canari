import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A product in an association's shop.
 * Products are inactive until the association completes Stripe Connect onboarding.
 */
@Entity('association_products')
export class AssociationProduct {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  associationId: string;

  @Column({ length: 200 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Fixed price in cents (null when only custom amounts are allowed). */
  @Column({ type: 'int', nullable: true })
  amountCents: number | null;

  @Column({ default: 'eur' })
  currency: string;

  /** `membership` - grants a tag; `balance_topup` - sends Cercle webhook; `other` - generic. */
  @Column({ length: 50 })
  type: 'membership' | 'balance_topup' | 'other';

  /** For `membership` products: tag name granted on purchase. */
  @Column({ length: 100, nullable: true })
  grantedTagName: string | null;

  /** When the membership tag expires. */
  @Column({ type: 'timestamptz', nullable: true })
  tagExpiresAt: Date | null;

  /** Whether the buyer may choose a custom amount (useful for topups). */
  @Column({ default: false })
  allowCustomAmount: boolean;

  @Column({ type: 'int', nullable: true })
  customAmountMinCents: number | null;

  @Column({ type: 'int', nullable: true })
  customAmountMaxCents: number | null;

  /** Cercle webhook URL (balance_topup products). Never returned in public API responses. */
  @Column({ length: 500, nullable: true })
  webhookUrl: string | null;

  /** HMAC-SHA256 secret for signing Cercle webhook payloads. Never exposed. */
  @Column({ length: 200, nullable: true })
  webhookSecret: string | null;

  /**
   * Whether the product is available to buyers.
   * Forced to false until the association completes Stripe Connect onboarding.
   */
  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /** When false, a user may only purchase once (membership: until tag expires). */
  @Column({ default: false })
  allowRepeatPurchase: boolean;

  /** Max paid purchases per user when repeat is allowed (null = unlimited). */
  @Column({ type: 'int', nullable: true })
  maxPurchasesPerUser: number | null;

  /** Global cap on paid purchases across all users (null = unlimited). */
  @Column({ type: 'int', nullable: true })
  maxPurchasesTotal: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
