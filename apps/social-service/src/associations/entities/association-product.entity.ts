import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A product in an association's shop.
 * Products are inactive until the association completes Stripe Connect onboarding.
 */
@Entity("association_products")
export class AssociationProduct {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  @Index()
  associationId: string;

  @Column({ length: 200 })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  /** Fixed price in cents (null when only custom amounts are allowed). */
  @Column({ type: "int", nullable: true })
  amountCents: number | null;

  @Column({ default: "eur" })
  currency: string;

  /** `membership` - grants a tag; `balance_topup` - sends Cercle webhook; `other` - generic. */
  @Column({ length: 50 })
  type: "membership" | "balance_topup" | "other";

  /** For `membership` products: tag name granted on purchase. */
  @Column({ length: 100, nullable: true })
  grantedTagName: string | null;

  /** When the membership tag expires. */
  @Column({ type: "timestamptz", nullable: true })
  tagExpiresAt: Date | null;

  /** Reserved to holders of the association's active cotisation tag (see `cotisation-tag.util.ts`). */
  @Column({ default: false })
  membersOnly: boolean;

  /** Reduced price in cents for cotisants (null = same as `amountCents`). Mirrors forms' `basePriceMember`. */
  @Column({ type: "int", nullable: true })
  amountCentsMember: number | null;

  /**
   * Named cotisation tier this product grants (e.g. `"avec-alcool"`), suffixed onto the
   * association's cotisation tag by `deriveCotisationTag`. Null means the single-tier form
   * (association-wide `cotisant:<slug>` tag) - the default, unchanged behavior.
   */
  @Column({ length: 100, nullable: true })
  variantKey: string | null;

  /**
   * Ordinal rank of this tier among the association's cotisation products, for "tier >= N"
   * optional-inclusion checks (higher includes lower). Null when tiers aren't ranked.
   */
  @Column({ type: "int", nullable: true })
  variantLevel: number | null;

  /**
   * Tag name that, when held by the buyer, qualifies them for `amountCentsMember` on THIS
   * product instead of the generic asso-wide cotisant check - the "pay the difference" lever
   * for tier upgrades (e.g. the "avec-alcool" product sets this to the "sans-alcool" tier's tag
   * so switchers only pay the delta). Null falls back to the generic `isBuyerCotisant` check.
   */
  @Column({ length: 100, nullable: true })
  memberPriceTag: string | null;

  /**
   * Arbitrary tag names gating purchase eligibility - the buyer must hold ANY of them (OR
   * semantics). Generalizes gating beyond the asso-scoped `membersOnly` check (e.g. a tag granted
   * by a form or another association). Takes precedence over `membersOnly` when set; null/empty
   * falls back to the `membersOnly` check.
   */
  @Column({ type: "text", array: true, nullable: true })
  requiredTags: string[] | null;

  /** Whether the buyer may choose a custom amount (useful for topups). */
  @Column({ default: false })
  allowCustomAmount: boolean;

  @Column({ type: "int", nullable: true })
  customAmountMinCents: number | null;

  @Column({ type: "int", nullable: true })
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

  @Column({ type: "int", default: 0 })
  sortOrder: number;

  /** When false, a user may only purchase once (membership: until tag expires). */
  @Column({ default: false })
  allowRepeatPurchase: boolean;

  /** Max paid purchases per user when repeat is allowed (null = unlimited). */
  @Column({ type: "int", nullable: true })
  maxPurchasesPerUser: number | null;

  /** Global cap on paid purchases across all users (null = unlimited). */
  @Column({ type: "int", nullable: true })
  maxPurchasesTotal: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
