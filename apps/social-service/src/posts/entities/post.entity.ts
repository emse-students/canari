import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** TypeORM entity representing a Canari post with optional polls, reactions, comments, and media. */
@Entity('posts')
export class Post {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  authorId: string;

  @Column('text')
  markdown: string;

  @Column('simple-array', { default: '' })
  mentions: string[];

  @Column('jsonb', { default: [] })
  links: any[];

  @Column({ type: 'uuid', nullable: true })
  attachedFormId: string;

  @Column('jsonb', { default: [] })
  images: any[];

  @Column('jsonb', { default: [] })
  polls: any[];

  @Column('jsonb', { default: [] })
  eventButtons: any[];

  @Column('jsonb', { default: [] })
  forms: any[];

  @Column({ type: 'uuid', nullable: true })
  @Index()
  associationId: string;

  /** Validated association agenda event this post relates to (compte-rendu, annonce, etc.). */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  linkedCalendarEventId: string | null;

  @Column({ type: 'uuid', nullable: true })
  paymentAssociationId: string;

  @Column('jsonb', { default: {} })
  reactions: Record<string, string>; // userId -> reactionType

  @Column('jsonb', { default: [] })
  comments: any[];

  @Column('jsonb', { default: [] })
  reports: any[];

  @Column({ type: 'boolean', default: false })
  pinned: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  scheduledAt: Date | null;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
