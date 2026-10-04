import { Entity, PrimaryColumn } from 'typeorm';

/**
 * A space a post is WIDENED to beyond its association's own (D19): the rare inter-campus case,
 * set only by a global admin or a nominative grant.
 */
@Entity('post_extra_spaces')
export class PostExtraSpace {
  @PrimaryColumn({ type: 'uuid' })
  postId: string;

  @PrimaryColumn({ type: 'uuid' })
  spaceId: string;
}
