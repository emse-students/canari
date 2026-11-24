import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * The server's receive time of the newest VISIBLE frame sent into a group (a message or a group
 * event the members see: `silent` false, durable, not addressed, never a Welcome or a Commit) - the
 * instant every recipient's copy already carries (migration 057). No content, no author.
 *
 * IT ORDERS THE CONVERSATION LIST OF A DEVICE THAT HOLDS NO HISTORY YET: a new device learns which
 * groups exist from `GET /mls/users/:id/groups` long before any history reaches it, and some history
 * never does. Said only to the group's admitted members (never to a seat awaiting admission).
 *
 * A TABLE OF ITS OWN rather than a column of `dm_groups`: an UPDATE of the group row would take a
 * row lock every concurrent send's `FOR SHARE` on that row waits for, so the sends of one group
 * would serialise on it. Upserted with GREATEST, moved forward only (`MessagingService.noteLastMessage`).
 * Deleted with the group (`GROUP_OWNED_TABLES`, and ON DELETE CASCADE for a hard delete) and by the
 * retention sweep once older than the queued copies it stands for (`MESSAGE_RETENTION_MS`).
 */
@Entity('dm_group_last_message')
export class GroupLastMessage {
  /** The group, one row each. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** The receive time of its newest visible frame. */
  @Index('IDX_dm_group_last_message_at')
  @Column({ type: 'timestamptz' })
  lastMessageAt: Date;
}
