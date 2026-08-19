import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Server-side metadata for an MLS group (either a 1-to-1 direct message or a
 * multi-member group chat). This record acts as the authoritative source of truth
 * for the group's current MLS epoch and key rotation state. The actual message
 * history and encrypted payloads are stored elsewhere; this table tracks only
 * the structural/crypto metadata needed to coordinate device membership.
 */
@Entity('dm_groups')
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Display name for group chats; null for direct messages. */
  @Column({ nullable: true })
  name?: string;

  /** Media-service ID of the group avatar (raw/public blob, like channel images).
   *  Null for direct messages and for groups without a custom photo. */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  imageMediaId?: string | null;

  /** True for multi-member group chats; false for 1-to-1 direct messages. */
  @Column({ default: false })
  isGroup: boolean;

  /**
   * Set when this group is a community's Graine key-distribution group, to the id of that
   * community. Null - overwhelmingly the common case - means an ordinary conversation.
   *
   * Such a group carries SEED material and never a message body, so it must never be presented as
   * a conversation. The single place that decides this is `GET /mls/users/:userId/groups`
   * (`members.controller`), which every client surface is fed from; see
   * `docs/wiki/protocols/channel-encryption.md` for why the exclusion lives there and nowhere else.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  distributionWorkspaceId?: string | null;

  /**
   * Set when this group is a PRIVATE SALON's Graine key-distribution group, to that salon's id.
   *
   * The sibling of {@link distributionWorkspaceId}, and **exactly one of the two may be set** - a
   * database CHECK says so (migration 018), because a row reachable from two scopes would be served
   * to two different rosters, which is the defect this scope exists to remove. Everything said
   * above about a community's group holds for this one: seeds only, never a conversation, entered
   * by external commit, no `dm_group_members` row.
   *
   * A public salon has none. Its audience is the community, so the community's group already is the
   * right roster and a second group would be the same set of people at a higher commit rate.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  distributionChannelId?: string | null;

  /** Monotonically increasing counter incremented on each manual key rotation,
   *  allowing clients to distinguish key rotation epochs from normal commits. */
  @Column({ default: 1 })
  keyVersion: number;

  /** Current MLS epoch number for this group; incremented by every Commit message.
   *  Used by `validateCommit` to gate commits against the expected base epoch. */
  @Column({ default: 0 })
  activeEpoch: number;

  /** JSONB snapshot of the most recent key-rotation Commit payload, kept so that
   *  devices coming online after the rotation can reconstruct the new epoch state. */
  @Column({ type: 'jsonb', nullable: true })
  latestKeyRotationPayload: any;

  /** Soft-delete timestamp. Null = active. Set on explicit deletion.
   *  The row is intentionally kept as a tombstone so devices can detect the transition. */
  @Column({ type: 'timestamp', nullable: true, default: null })
  deletedAt?: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
