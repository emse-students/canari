import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Epoch-indexed, replayable log of accepted MLS commits for a group (rung-1 backbone).
 *
 * The server linearizes commits via `validateCommit` (Redis lock + strict `baseEpoch ==
 * activeEpoch` gate). Each accepted commit is recorded here keyed by the epoch it advances FROM
 * (`baseEpoch`), so a device that fell behind can fetch and replay the exact ordered commits it
 * missed (`baseEpoch >= its local epoch`) instead of dropping its state and re-Welcoming. Only one
 * commit can ever advance from a given epoch (linearization), enforced by the unique index.
 *
 * Stores only ciphertext (the serialised MLS Commit, base64) - no keys, no plaintext - so the
 * server remains a pure ordering/durability layer with no privacy regression.
 */
@Entity('mls_commit_log')
@Index(['groupId', 'baseEpoch'], { unique: true })
export class MlsCommitLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** MLS group this commit belongs to. */
  @Column({ type: 'uuid' })
  groupId: string;

  /** The epoch this commit advances FROM. A device at epoch `e` replays commits with
   *  `baseEpoch >= e` in ascending order to catch up. Unique per group. */
  @Column({ type: 'int' })
  baseEpoch: number;

  /** Base64-encoded serialised MLS Commit (PublicMessage) - the exact bytes fanned out to members. */
  @Column({ type: 'text' })
  commit: string;

  /** Device that produced the commit (diagnostic / attribution). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  senderDeviceId?: string;

  @CreateDateColumn()
  createdAt: Date;
}
