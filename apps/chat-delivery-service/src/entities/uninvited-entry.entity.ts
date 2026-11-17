import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * One entry members reported as nobody's - a user absent from a conversation's tree who admitted
 * themselves by their own commit - once per `(groupId, entrant, epoch, kind)` (migration 053).
 *
 * THE QUESTION THIS ROW ANSWERS, AND THE ONLY ONE: "was this entry already counted under this
 * kind?". It is the `[UNINVITED_ENTRY]` line's deduplication made durable, so the count the
 * admission rule's fix-forward is read on survives a deploy and holds across replicas; it is never
 * evidence that the entrant is or is not a member (each reporting device decides that from its own
 * tree, and `kind` is what it decided).
 *
 * Every column is the value the log line prints, sanitized the same way: `entrantUserDevice` carries
 * the user id cut to eight characters, never a full one, so this table holds nothing the line did
 * not. PSEUDONYMOUS, NOT ANONYMOUS: the device id re-identifies the person while their key package
 * exists. Bounded by the retention window (`pruneUninvitedEntries`, daily and at boot), deleted with
 * the group (`GROUP_OWNED_TABLES`) and with the account (`ACCOUNT_ERASURE_COVERAGE`).
 */
@Entity('uninvited_entries')
@Index('IDX_uninvited_entries_firstSeenAt', ['firstSeenAt'])
export class UninvitedEntry {
  /** The conversation entered. A reporter is refused unless it is a member of it. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** The admitted leaf as the line prints it, `userId:deviceId` with the user id shortened. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  entrantUserDevice: string;

  /** The epoch the entering commit created: its digits, or `invalid`/`unstated` (never longer). */
  @PrimaryColumn({ type: 'varchar', length: 32 })
  epoch: string;

  /** What the reporting device decided (`new-person`, `returning`, ...), from the allowlist. */
  @PrimaryColumn({ type: 'varchar', length: 32 })
  kind: string;

  /** Where the FIRST reporter's record of the group starts (`watched_from=` on the line). */
  @Column({ type: 'varchar', length: 32 })
  watchedFrom: string;

  /** When the entry was first counted. Printed and aged out, never compared to decide a count. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  firstSeenAt: Date;
}
