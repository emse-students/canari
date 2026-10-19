import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Live } from './live.entity';

/**
 * One sealed segment of a live, as stored (WP-L3, migration 091). The bytes are in the media store
 * under `live/<liveId>/<name>`; this row is what the manifest lists.
 *
 * `name` is a random uuid the SERVER chose at ingest, so a segment's address is learned only from
 * the manifest: a removed viewer, refused the manifest, cannot guess the next one. `sha256` makes a
 * repeated upload of the same index idempotent (same bytes -> same answer) and a different body a
 * conflict, never a silent replacement.
 */
@Entity('live_segments')
@Check('live_segments_index', `"index" >= 0`)
@Check('live_segments_bytes', `"bytes" > 0`)
export class LiveSegment {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'live_segments_pkey' })
  liveId: string;

  @PrimaryColumn({ type: 'integer', primaryKeyConstraintName: 'live_segments_pkey' })
  index: number;

  /** Foreign key `live_segments_live_fk`: the segments' rows go with their live. */
  @ManyToOne(() => Live, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'liveId', foreignKeyConstraintName: 'live_segments_live_fk' })
  live?: Live;

  @Column({ type: 'uuid' })
  name: string;

  @Column({ type: 'integer' })
  bytes: number;

  @Column({ type: 'char', length: 64 })
  sha256: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
