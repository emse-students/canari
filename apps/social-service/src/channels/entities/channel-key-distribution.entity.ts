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

  @Column()
  workspaceId: string;

  @Column()
  channelId: string;

  @Column()
  targetUserId: string;

  @Column()
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
