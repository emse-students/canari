import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The outbox entry of a stored salon row (migration 093): written in the send's transaction,
 * deleted once the broadcast and the push are handed off, drained at boot after a process death.
 *
 * Declared so that a schema built by `synchronize` (CI's boot job, a local stack) has the table the
 * boot drain reads; PRODUCTION's table comes from the migration, which also carries the foreign key
 * to the message (it cascades). Read and written with raw SQL by `ChannelService`.
 */
@Entity('channel_message_fanout')
export class ChannelMessageFanout {
  @PrimaryColumn({ type: 'uuid', name: 'messageId' })
  messageId: string;

  /** What the push needs and the row lacks: the cleartext mentions and the opaque seed frame. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
