import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Where a checkout attempt stands. `open` is the only state a request can still be paid in;
 * `declined` is Lydia's state 5, `expired`/`cancelled` its state 6 (after / before `expiresAt`,
 * since the state alone cannot tell them apart), and `cancelled` also an attempt whose request was
 * never issued. Only `paid` counts as a purchase.
 */
export type ProductCheckoutStatus = 'open' | 'paid' | 'declined' | 'expired' | 'cancelled';

/**
 * ONE boutique checkout ATTEMPT (migration 101). Its id is the attempt id of the Lydia `order_ref`
 * (`product:<productId>:<id>`), and a purchase is settled FROM it: the product, the buyer
 * and the amount are what this row says, never what a callback or a return URL says. See
 * docs/wiki/frontend/modules/payments.md, "A product checkout is a row, one per attempt".
 */
@Entity('product_checkouts')
@Index('product_checkouts_request_uuid', ['requestUuid'])
@Index('product_checkouts_request_id', ['requestId'])
@Index('product_checkouts_product_user_status', ['productId', 'userId', 'status'])
@Index('product_checkouts_one_open', ['productId', 'userId'], {
  unique: true,
  where: `"status" = 'open'`,
})
@Check('product_checkouts_status', `status IN ('open', 'paid', 'declined', 'expired', 'cancelled')`)
@Check('product_checkouts_amount', `"amountCents" >= 0`)
export class ProductCheckout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  productId: string;

  /** The buyer - a 64-char hex user id, never a uuid. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** The product's own association: the one the purchase is booked to. */
  @Column({ type: 'uuid' })
  associationId: string;

  /** The association whose payment account the request was issued to (itself, or its parent). */
  @Column({ type: 'uuid' })
  paymentAssociationId: string;

  /**
   * The Lydia Business (`vendor_token`) the request was issued to, as it was at issue time: the one
   * account that can read or cancel it, and the only one whose verified callback may settle it.
   */
  @Column({ type: 'varchar', length: 255 })
  vendorToken: string;

  /** What the request was issued for, resolved server-side at checkout. The ONLY amount recorded. */
  @Column({ type: 'int' })
  amountCents: number;

  @Column({ type: 'varchar', length: 3, default: 'eur' })
  currency: string;

  /** Snapshot of the product's name: the record survives the product's deletion. */
  @Column({ type: 'varchar', length: 200 })
  productName: string;

  /** Lydia's `request_uuid`, the id `request/state` reads. Null until request/do answered. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  requestUuid: string | null;

  /** Lydia's numeric `request_id`, the id its callbacks and `request/cancel` carry. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  requestId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status: ProductCheckoutStatus;

  /** When the request stops being payable: the `expire_time` request/do was sent, from creation. */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  settledAt: Date | null;

  /**
   * The tier the buyer held when this attempt OPENED (migration 112): the product id of the tier a
   * cotisation checkout was ranked against, frozen so the settlement decides on what the opening
   * decided and never on a price edited since (`ProductsService.settlementMayGrant`). Null when
   * nothing was held, for a non-tier product, and for an attempt opened before the column existed.
   */
  @Column({ type: 'uuid', nullable: true })
  heldTierProductId: string | null;

  /** The purchase record a `paid` settlement wrote, exactly once. */
  @Column({ type: 'uuid', nullable: true })
  purchaseRecordId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
