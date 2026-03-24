import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

@Entity('channel_messages')
@Index(['channelId'])
export class ChannelMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  workspaceId: string;

  @Column()
  channelId: string;

  @Column()
  authorId: string;

  @Column('text')
  content: string;

  @Column({ nullable: true })
  replyTo: string;

  @Column('jsonb', { default: [] })
  attachments: any[];

  @Column('jsonb', { default: {} })
  reactions: Record<string, string[]>;

  @Column('jsonb', { default: {} })
  metadata: any;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
