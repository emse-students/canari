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

  /**
   * The claimant's user id, or null while the code is unclaimed.
   *
   * `varchar(255)`, NOT `uuid`: a user id in this estate is the 64-character hex digest carried in
   * `x-user-id`. Migration 047 declared this column `uuid` and every claim therefore failed with
   * SQLSTATE 22P02 before touching a row (migration 056). Every sibling user-id column in this
   * service uses exactly this type - keep it that way.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  claimedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
