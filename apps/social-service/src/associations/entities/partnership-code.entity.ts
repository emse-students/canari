import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * One code in a `code_pool` partnership card's stock.
 * `claimedByUserId`/`claimedAt` are null until a student claims it; the partial unique index
 * `idx_partnership_codes_card_claimant` (migration 047) guarantees at most one claimed row per
 * `(cardId, claimedByUserId)`, which is what makes claiming idempotent under concurrency - see
 * `PartnershipsService.claimCard`.
 */
@Entity('partnership_codes')
export class PartnershipCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  cardId: string;

  @Column({ length: 200 })
  code: string;

  @Column({ type: 'uuid', nullable: true })
  claimedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
