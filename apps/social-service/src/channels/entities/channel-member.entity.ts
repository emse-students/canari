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

  /** Display order of this member's workspaces in their own sidebar (ascending). Personal, not shared across members. */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
