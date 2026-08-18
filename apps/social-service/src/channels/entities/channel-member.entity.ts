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

  /** Display order of this member's workspaces in their own sidebar (ascending). Personal, not shared across members. */
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
