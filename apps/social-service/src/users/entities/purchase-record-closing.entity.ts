import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * How a payment marked `paid_not_granted` was settled by a person: the money went back (`refunded`,
 * outside Canari), or the tier was granted by hand (`granted`, by the closing itself).
 */
export type PurchaseClosingOutcome = 'refunded' | 'granted';

/** Every outcome a closing may record, as the CHECK of migration 113 lists them. */
export const PURCHASE_CLOSING_OUTCOMES: readonly PurchaseClosingOutcome[] = ['refunded', 'granted'];

/** The unique index of migration 113 that makes a payment closable once. */
export const CLOSING_UNIQUE_INDEX = 'purchase_record_closings_one_per_record';

/**
 * ONE closing of a purchase record marked `paid_not_granted` (migration 113): which outcome a
 * manager recorded, who, and when by the server's own clock. Written once per purchase record (the
 * unique index), never updated; the purchase record keeps its mark as history, and the hourly report
 * counts only the marked records that have no row here (docs/wiki/cotisations.md "Rising to a
 * higher tier").
 */
@Entity('purchase_record_closings')
@Index(CLOSING_UNIQUE_INDEX, ['purchaseRecordId'], { unique: true })
@Check('purchase_record_closings_outcome', `outcome IN ('refunded', 'granted')`)
export class PurchaseRecordClosing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The purchase record closed. A plain uuid: purchase records are never deleted. */
  @Column({ type: 'uuid' })
  purchaseRecordId: string;

  @Column({ type: 'varchar', length: 16 })
  outcome: PurchaseClosingOutcome;

  /** The manager who recorded the outcome - a 64-char hex user id, never a uuid. */
  @Column({ type: 'varchar', length: 255 })
  closedByUserId: string;

  /** Written by the database (`DEFAULT now()`), never by a client. */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
