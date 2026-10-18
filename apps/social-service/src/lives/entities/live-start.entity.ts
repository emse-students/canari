import { CreateDateColumn, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One live START, kept for an hour (migration 091): what `LIVE_STARTS_PER_HOUR` counts. A live's own
 * row is deleted at its end (no replay, L3), so the count of an account's recent starts needs rows
 * that outlive their live. The live sweep deletes them once the hour is past; an account erasure
 * deletes the account's.
 */
@Entity('live_starts')
@Index('live_starts_broadcaster_idx', ['broadcasterId', 'startedAt'])
export class LiveStart {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The account that started a live - a 64-char hex user id, never a uuid. */
  @Column({ type: 'varchar', length: 255 })
  broadcasterId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt: Date;
}
