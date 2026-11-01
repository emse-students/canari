import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * One stretch of time during which a person was a member of an MLS conversation group - from the
 * enrolment that created their `dm_group_members` row to the removal that deleted it.
 *
 * **WHY IT EXISTS (user, 2026-10-14): A REMOVE HOLDS AGAINST A LATER RE-ADD.** A member removed from
 * a group conversation and added back keeps what preceded their removal and NEVER receives what was
 * sent while they were out. `dm_group_members` cannot say that: a removal hard-deletes its row and a
 * re-add creates a fresh one, so the only thing it remembers is the LATEST arrival. The gaps between
 * these rows are the exclusion windows the answering peer must withhold from every history bundle
 * (`GET mls/groups/:groupId/exclusions`, `historyEntitlement.ts` on the client) - the whole design
 * is in `docs/wiki/protocols/history-reconciliation.md`.
 *
 * Lifecycle: opened by `ensureGroupMember` (both enrolment routes), closed by `removeGroupMember`
 * in the same transaction that deletes the membership row, deleted with the group
 * (`GROUP_OWNED_TABLES`) and with the account. At most ONE open row per `(groupId, userId)`, which
 * the partial unique index enforces, so a second enrolment of somebody already present is a no-op
 * exactly as it is on `dm_group_members`.
 *
 * Both instants of the stretch are written by this service's own clock (`new Date()`), the clock `sendMessage`
 * stamps `queued_message.createdAt` with - the server receive time the client compares them
 * against. No client clock ever enters this table. The columns carry no time zone, so the service
 * must run in UTC (it does, as does Postgres - read on production 2026-10-14).
 */
@Entity('dm_group_membership_intervals')
@Index('IDX_dm_group_membership_intervals_group_user', ['groupId', 'userId'])
@Index('UQ_dm_group_membership_intervals_open', ['groupId', 'userId'], {
  unique: true,
  where: '"leftAt" IS NULL',
})
export class GroupMembershipInterval {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Group the stretch of membership belongs to. */
  @Column({ type: 'uuid' })
  groupId: string;

  /** Person who was a member. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /**
   * When the enrolment that opened this stretch was written - or, for an invitation link's seat,
   * when the member's Add that answered the ask was accepted: the link opens the stretch when the
   * person asks, and that commit re-dates it (`dateArrivalAtAdmission`), so the wait outside is never
   * read as membership.
   */
  @CreateDateColumn()
  joinedAt: Date;

  /** When the removal that closed it was written; `null` while the person is still a member. */
  @Column({ type: 'timestamp', nullable: true })
  leftAt: Date | null;

  /**
   * When a commit admitted this person's first device into the stretch, if that was EARLIER than
   * `joinedAt`; `null` when no device row preceded the enrolment (migration 033).
   *
   * **WHY IT IS HERE, AND NOT READ FROM THE DEVICE ROWS** (review of #2226). A commit can admit an
   * invitee's device days before their enrolment opens this row (added = arrived, see
   * `withheldWindows`), and that device row was the only record of the real arrival. Revoking the
   * device (`purgeDeviceFootprint`) deletes its rows, so the arrival moved later and the person's
   * next device lost the span between the two. Copied here at enrolment, the arrival is a fact a
   * purge cannot reach.
   *
   * It decides the before-arrival span and the start of the stretch for `for`, NEVER a gap: the
   * 2026-10-14 window still ends at `joinedAt`. Written by `ensureGroupMember` from the database's
   * clock (the device row's `CreateDateColumn`), the second of the two clocks `withheldWindows`
   * bounds. Cleared when a member's Add answers an invitation link's ask: the rows it was copied
   * from were written when the person asked, not when anybody admitted them.
   */
  @Column({ type: 'timestamp', nullable: true })
  admittedAt: Date | null;

  /**
   * The group's `seatGeneration` when the removal that closed this stretch was written - the
   * generation that removal moved it to, under the seat lock (`endGroupMembership`). `null` while
   * open, and for a stretch closed before migration 039. A COUNTER, not a clock: it orders this
   * departure against the epoch a commit was built on (`Group.epochSeatGeneration`), so an Add built
   * before the departure enrols nobody after it (`enrolAdmittedPeople`).
   */
  @Column({ type: 'integer', nullable: true })
  leftAtSeatGeneration: number | null;
}
