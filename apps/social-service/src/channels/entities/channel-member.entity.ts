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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
