import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export type DeviceGroupStatus =
  | 'pending'
  | 'welcome_sent'
  | 'welcome_received'
  | 'stale';

@Entity('dm_device_group_memberships')
@Unique(['deviceId', 'groupId'])
@Index(['userId', 'groupId'])
@Index(['groupId', 'status'])
export class DeviceGroupMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  userId: string;

  @Column()
  deviceId: string;

  @Column({ type: 'uuid' })
  groupId: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'welcome_sent', 'welcome_received', 'stale'],
    default: 'pending',
  })
  status: DeviceGroupStatus;

  @Column({ type: 'int', default: 0 })
  lastEpochSeen: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
