import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity()
@Index(['recipientId', 'deviceId'])
export class QueuedMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  recipientId: string;

  @Column()
  deviceId: string;

  @Column({ nullable: true })
  proto?: string;

  @Column({ nullable: true })
  isWelcome?: boolean;

  @Column({ nullable: true })
  senderId?: string;

  @Column({ nullable: true })
  senderDeviceId?: string;

  @Column({ nullable: true })
  groupId?: string;

  @Column({ nullable: true })
  type?: string;

  @Column({ nullable: true })
  content?: string;

  @CreateDateColumn()
  createdAt: Date;
}
