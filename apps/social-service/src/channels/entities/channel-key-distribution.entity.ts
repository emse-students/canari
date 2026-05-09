import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type ChannelKeyDistributionStatus =
  | 'pending_key_distribution'
  | 'key_sent'
  | 'key_received'
  | 'key_acked'
  | 'failed';

@Entity('channel_key_distributions')
@Index(['channelId', 'targetUserId', 'keyVersion'])
export class ChannelKeyDistribution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  workspaceId: string;

  @Column({ type: 'uuid' })
  channelId: string;

  @Column({ type: 'varchar', length: 255 })
  targetUserId: string;

  @Column({ type: 'varchar', length: 255 })
  invitedBy: string;

  @Column()
  keyVersion: number;

  @Column({
    type: 'varchar',
    default: 'pending_key_distribution',
  })
  status: ChannelKeyDistributionStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  ackedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
