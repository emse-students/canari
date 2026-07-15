import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique } from 'typeorm';

/**
 * Records that a USER has voluntarily dismissed a conversation (manual local delete or manual
 * leave) and wants it gone from ALL their devices - not just the one where the action happened.
 *
 * Why this is needed: from the server's membership state alone, "I deleted/left this group" is
 * indistinguishable from "someone else deleted it" or "I was excluded" (all three remove my
 * `dm_group_members` row, or tombstone the group). A peer-deleted group or an exclusion must stay
 * visible locally (banner + manual delete), whereas a self-dismissed one must be removed
 * everywhere. This per-user, per-group marker is the authoritative signal the discovery uses to
 * purge instead of showing the "deleted" banner.
 *
 * Lifecycle: inserted on manual delete/leave ; removed when the user is re-added (a fresh Welcome
 * means they want the conversation back - see `undismiss`). Independent of the group's own
 * lifecycle, so it survives even after the group row is hard-purged.
 */
@Entity('dm_user_dismissed_groups')
@Unique(['userId', 'groupId'])
export class UserDismissedGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** User who dismissed the conversation (the marker applies to all their devices). */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** Group the user dismissed. Stored as text (not a FK) so it outlives the group row. */
  @Column({ type: 'varchar', length: 255 })
  groupId: string;

  @CreateDateColumn()
  dismissedAt: Date;
}
