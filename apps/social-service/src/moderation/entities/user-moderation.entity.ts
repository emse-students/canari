import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * Mute state for a user — stored in social-service to avoid cross-service HTTP calls.
 * A muted user can still read but cannot post, react, or comment.
 */
@Entity('user_moderation')
export class UserModeration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index({ unique: true })
  userId: string;

  @Column({ default: false })
  isMuted: boolean;

  @Column({ nullable: true })
  mutedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  mutedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  mutedReason: string | null;
}
