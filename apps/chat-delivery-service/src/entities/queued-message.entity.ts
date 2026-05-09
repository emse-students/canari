import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('queued_message')
@Index(['recipientId', 'deviceId'])
export class QueuedMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  recipientId: string;

  @Column()
  deviceId: string;

  @Column({ nullable: true })
  proto?: string;

  @Column({ nullable: true })
  isWelcome?: boolean;

  @Column({ nullable: true })
  isCommit?: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  senderId?: string;

  @Column({ nullable: true })
  senderDeviceId?: string;

  @Column({ type: 'uuid', nullable: true })
  groupId?: string;

  @Column({ nullable: true })
  type?: string;

  @Column({ nullable: true })
  content?: string;

  @Column({ nullable: true })
  ratchetTree?: string;

  @CreateDateColumn()
  createdAt: Date;
}
