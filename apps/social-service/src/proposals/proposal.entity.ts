import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/**
 * What an association may ASK, and nothing it can impose (migration 073). `repost` is D38 (sending
 * a post to another association), `coorganise` is D39 (asking an association to co-organise an
 * event, migration 074) - which is why nothing here names a post. `repost-personal` is D38b
 * (migration 096): an association asks a PERSON to let it republish their personal post, and the
 * person decides - the one kind whose receiver is a user.
 */
export const PROPOSAL_KINDS = ['repost', 'coorganise', 'repost-personal'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** A proposal is pending until the receiver accepts or refuses it, or the sender withdraws it. */
export type ProposalStatus = 'pending' | 'accepted' | 'refused' | 'withdrawn';

/**
 * The `decidedBy` of a request the SERVER voided (D38b): its asker no longer speaks for the sending
 * association (flag lost, left, muted, erased). Not the person asked - they decided nothing - and not
 * the asker. The account erasure writes the same literal in SQL (`proposals_voided`), asserted by
 * its spec.
 */
export const PROPOSAL_VOIDED_BY = '[voided]';

/**
 * One proposal. `subjectId` is the thing proposed (a post for `repost` and `repost-personal`, an
 * event for `coorganise`) and carries no foreign key because it names a different table per kind;
 * a trigger per subject table (migrations 073, 074 and 096) removes the rows whose subject is
 * deleted.
 *
 * EXACTLY ONE RECEIVER (migration 096's CHECKs): `toAssociationId` for an association kind,
 * `toUserId` for `repost-personal` and for it alone. The same (kind, subject, receiver) cannot be
 * pending or decided twice - for a user kind the receiver is fixed by the subject, so the index is
 * on the SENDING association instead. A withdrawn row makes room for a new one, a refused one does
 * not.
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

  /** The association asked, whose holders of the kind's acceptor flag decide. NULL for a user kind. */
  @Column({ type: 'uuid', nullable: true })
  toAssociationId: string | null;

  /** The PERSON asked (`repost-personal`: the post's author), who alone decides. NULL otherwise. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  toUserId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: ProposalStatus;

  @Column({ type: 'varchar', length: 255 })
  proposedBy: string;

  /**
   * Who accepted, refused or withdrew it; NULL while pending. {@link PROPOSAL_VOIDED_BY} when the
   * server voided it because its asker no longer speaks for the association - nobody decided that.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  decidedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;
}
