import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
import type { SpaceCampus, SpaceFormation } from './space.entity';

/**
 * One visibility rule chosen by a post's author (user, 2026-10-04). NULL means "any", as on
 * {@link import('./association-audience.entity').AssociationAudience}. A post with no rule inherits its publisher's rules; with rules, it is
 * visible to those instead, and the server refuses a rule outside the publisher's own (its
 * ceiling) - going beyond is a nominative grant.
 */
@Entity('post_audiences')
export class PostAudience {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  postId: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  formation: SpaceFormation | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  campus: SpaceCampus | null;
}
