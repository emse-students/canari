import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/**
 * What one association may ask of another, and nothing it can impose (migration 073). `repost` is
 * the first kind (D38: sending a post to another association); event co-organisation (D39) is
 * meant to be the next, which is why nothing here names a post.
 */
export const PROPOSAL_KINDS = ['repost'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** A proposal is pending until the receiver accepts or refuses it, or the sender withdraws it. */
export type ProposalStatus = 'pending' | 'accepted' | 'refused' | 'withdrawn';

/**
 * One proposal. `subjectId` is the thing proposed (a post for `repost`) and carries no foreign key
 * because it names a different table per kind; the migration's trigger removes a `repost` row whose
 * post is deleted. The same (kind, subject, target) cannot be pending or decided twice - a
 * withdrawn row makes room for a new one, a refused one does not.
 */
@Entity('proposals')
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  kind: ProposalKind;

  @Column({ type: 'uuid' })
  subjectId: string;

  /** The association that proposes, and whose holders of the kind's sender flag may withdraw. */
  @Column({ type: 'uuid' })
  fromAssociationId: string;

  /** The association asked, and whose holders of the kind's acceptor flag decide. */
  @Column({ type: 'uuid' })
  toAssociationId: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: ProposalStatus;

  @Column({ type: 'varchar', length: 255 })
  proposedBy: string;

  /** Who accepted, refused or withdrew it; NULL while pending. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  decidedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;
}
