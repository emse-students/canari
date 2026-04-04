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
  | 'added'
  | 'welcome_sent'
  | 'welcome_received';

@Entity('dm_device_group_memberships')
@Unique(['deviceId', 'groupId'])
@Index(['userId', 'groupId'])
@Index(['groupId', 'status'])
export class DeviceGroupMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  deviceId: string;

  @Column()
  groupId: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'added', 'welcome_sent', 'welcome_received'],
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
