import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * One association republishing one post (D38, migration 073). The post then reaches that
 * association's audience as well as its own - `postVisibleToUserSql` reads these rows. The pair is
 * the key, so the same association cannot republish the same post twice.
 */
@Entity('post_republications')
export class PostRepublication {
  @PrimaryColumn({ type: 'uuid' })
  postId: string;

  @PrimaryColumn({ type: 'uuid' })
  associationId: string;

  /** The member who republished, or who accepted the proposal that did. */
  @Column({ type: 'varchar', length: 255 })
  republishedBy: string;

  @CreateDateColumn({ type: 'timestamptz' })
  republishedAt: Date;
}
