import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/** TypeORM entity representing a per-role permission override on a channel. */
@Entity('channel_permission_overrides')
@Index(['channelId', 'roleId', 'permission'], { unique: true })
export class ChannelPermissionOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  channelId: string;

  @Column({ type: 'uuid', nullable: true })
  roleId: string | null;

  @Column({ type: 'varchar' })
  permission: string;

  @Column({ type: 'varchar' })
  value: 'allow' | 'deny';

  @CreateDateColumn()
  createdAt: Date;
}
