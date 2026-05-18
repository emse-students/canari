import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/** TypeORM entity representing a notification triggered by a comment or reply on a post. */
@Entity('post_notifications')
export class PostNotification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  recipientId: string;

  @Column()
  type: string; // 'comment' | 'reply' | 'reaction' | 'mention' | 'form_reminder'

  @Column()
  postId: string;

  @Column()
  actorId: string;

  @Column({ nullable: true })
  actorName: string;

  @Column()
  text: string;

  @Column({ default: false })
  read: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
