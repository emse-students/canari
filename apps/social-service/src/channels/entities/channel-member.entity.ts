import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/** TypeORM entity representing a user's membership in a workspace, including their role IDs and per-channel keys. */
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

  @Column('jsonb', { default: {} })
  keys: Record<string, string>;

  /**
   * Per-channel push notification level keyed by channelId (`all` | `mentions` | `none`).
   * A channel absent from the map defaults to `all`. Scoped to this member (per workspace),
   * so it covers every channel the member can access in that workspace.
   */
  @Column('jsonb', { default: {} })
  notifLevels: Record<string, 'all' | 'mentions' | 'none'>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
