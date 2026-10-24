import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/** TypeORM entity representing a user's membership in a workspace: their role IDs, per-channel notification levels and sidebar order. */
@Entity('channel_members')
@Index(['workspaceId', 'userId'], { unique: true })
// The viewer lookup of every presence poll filters on userId alone, which the unique
// (workspaceId, userId) cannot serve. Named as migration 089 names it, so dev's synchronize and
// production carry the same index.
@Index('IDX_channel_members_user', ['userId'])
export class ChannelMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column({ type: 'varchar', length: 255 })
  userId: string;

  @Column('simple-array', { default: '' })
  roleIds: string[];

  /**
   * Per-channel push notification level keyed by channelId (`all` | `mentions` | `none`).
   * A channel absent from the map defaults to `all`. Scoped to this member (per workspace),
   * so it covers every channel the member can access in that workspace.
   */
  @Column('jsonb', { default: {} })
  notifLevels: Record<string, 'all' | 'mentions' | 'none'>;

  /**
   * How far this member has read each salon, keyed by channelId: the server `createdAt` (epoch ms)
   * of the newest message read. Only ever raised (`advanceChannelReadMark`), and what a salon's
   * read receipts are made of (migration 066).
   */
  @Column('jsonb', { default: {} })
  readMarks: Record<string, number>;

  /**
   * How far this member has CLEARED each salon's unread count without reading it ("Marquer tout
   * comme lu", migration 082), keyed by channelId like `readMarks` - but private: never a receipt.
   *
   * Declared so `synchronize` (on outside production) creates it and does not DROP it: an
   * undeclared column is removed at every local boot, and the unread count names it. Kept out of
   * every TypeORM SELECT and UPDATE (`select`/`insert`/`update: false`), so before migration 082
   * runs on a deploy only the INSERT of a new membership names it (its RETURNING), never a read.
   * Read and written by raw SQL only (`listUnreadCounts`, `clearWorkspaceUnread`).
   */
  @Column({ type: 'jsonb', default: {}, select: false, insert: false, update: false })
  clearedMarks?: Record<string, number>;

  /**
   * The signed admission this member was given (migration 107): an opaque voucher a member's device
   * signed - the admin who added them, or the member whose invite link they followed. The server
   * stores and serves it and cannot forge it; members check it before handing over the community's
   * past (channel-encryption section 25). Null for a member admitted before the proof existed, or
   * through a link that carried none.
   */
  @Column({ type: 'text', nullable: true, default: null })
  admissionVoucher: string | null;

  /** Display order of this member's workspaces in their own sidebar (ascending). Personal, not shared across members. */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
