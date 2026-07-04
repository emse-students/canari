import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Latest MLS GroupInfo per group - the base for an external-commit self-join (Phase 4).
 *
 * A member that lacks local MLS state (never Welcomed, forgot its state, fell below the commit-log
 * floor) rejoins by building an external commit against the CURRENT GroupInfo, without waiting for
 * a peer Welcome. The delivery service stores the newest GroupInfo (refreshed by the committer after
 * every accepted commit - a new group's first member-add is itself a commit) and serves it ONLY to
 * authorized roster members.
 *
 * `baseEpoch` is the epoch the stored GroupInfo describes (== the group's activeEpoch when it was
 * produced). A joiner submits its external commit with this value as `baseEpoch`; the standard
 * epoch gate (`baseEpoch == activeEpoch`) rejects it if a newer commit has landed, and the joiner
 * retries with a fresher GroupInfo. Writes are monotonic (never overwrite a newer epoch).
 *
 * Stores only the serialised GroupInfo (base64) - no keys, no plaintext: the ratchet tree and
 * external public key it carries are public group state, so this is not a privacy regression.
 */
@Entity('mls_group_info')
export class MlsGroupInfo {
  /** One row per group. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** Base64-encoded serialised GroupInfo (MlsMessageOut wire form, ratchet tree included). */
  @Column({ type: 'text' })
  groupInfo: string;

  /** Epoch the stored GroupInfo describes; the joiner submits its external commit against it. */
  @Column({ type: 'int' })
  baseEpoch: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
