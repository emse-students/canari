import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * The claim that the ONE push "X wants to join" was sent for a person's ask - one row per
 * `(groupId, userId)`, deliberately NOT on the seat row (migration 043).
 *
 * A seat row dies with a self-withdrawal and a re-follow of the link writes a new one, so a claim
 * kept on it was re-armed by the joiner alone: accept, withdraw, accept again pushed every member
 * each time, with no member acting. This row outlives the seat and is re-armed only by a MEMBER's
 * Decline: `gen` is the person's `dm_seat_evictions.declinedAtSeatGeneration` (0 when none), a
 * counter only a Decline moves, and a claim succeeds only for a strictly larger one
 * (`pushJoinAsk`, `utils/join-ask-announce.ts`). A withdrawal or an expiry leaves it unchanged, so
 * it re-arms nothing. Durable state, never a clock.
 *
 * Deleted with the group (`GROUP_OWNED_TABLES`) and with the account.
 */
@Entity('dm_join_ask_pushes')
export class JoinAskPush {
  /** The group the person asked to join. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** The person who asked. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** The Decline counter the last push was claimed at. */
  @Column({ type: 'integer', default: 0 })
  gen: number;
}
