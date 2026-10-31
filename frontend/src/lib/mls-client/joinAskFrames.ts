/**
 * How an invitation-link ask ended, as chat-delivery announces it to every online admitted member
 * (`group.join_ask.settled`, `apps/chat-delivery-service/src/utils/join-ask-announce.ts`): a member's
 * Add admitted the person, a member declined or removed the seat, nobody answered in time, or the
 * person withdrew their own seat.
 */
export type JoinAskOutcome = 'admitted' | 'declined' | 'expired' | 'withdrawn';

/** Every {@link JoinAskOutcome}: what a settlement frame is validated against. */
export const JOIN_ASK_OUTCOMES: readonly JoinAskOutcome[] = [
  'admitted',
  'declined',
  'expired',
  'withdrawn',
];

/** Whether `value` is a {@link JoinAskOutcome}. */
export function isJoinAskOutcome(value: unknown): value is JoinAskOutcome {
  return (JOIN_ASK_OUTCOMES as readonly unknown[]).includes(value);
}
