import { msUntilPollDeadline, type PollDeadline } from '$lib/posts/pollVote';

/**
 * THE INSTANT A CARD JUDGES ITS POLL DEADLINES AGAINST, AND IT MOVES ONLY WHEN ONE ARRIVES.
 *
 * A poll's closure used to be read as `endsAt <= Date.now()` during render. `Date.now()` is not
 * reactive, so that answered for the instant the card happened to be drawn and nothing re-ran it:
 * a deadline arriving while the card sat on screen changed nothing until an unrelated redraw, and
 * until then a reader could submit into a poll the server would refuse with a 403. Learning that
 * by being refused is learning by failing what a fact could have told us - the deadline is KNOWN,
 * and the moment it becomes interesting is therefore known too.
 *
 * **ONE TIMER PER CARD, FIRING ONCE PER DEADLINE.** Not an interval, and not one timer per poll:
 * {@link msUntilPollDeadline} returns only the earliest deadline still ahead, and when that one
 * lands this schedules the next. A card whose polls have no deadline, or whose deadlines are all
 * behind it, schedules nothing at all.
 *
 * **WHICH DIRECTION THE CLOCK MAY BE WRONG IN, AND WHY THAT IS THE WHOLE ARGUMENT.** The delay is
 * computed from the deadline the SERVER sent, against this browser's clock, so skew shifts when
 * the card notices. That is safe here in a way the old comparison was not, and the difference is
 * not a matter of degree: a skewed comparison produced a verdict of "still open" that NOTHING
 * would ever revisit, so the error was permanent (COMM-15, 2026-08-25). A skewed delay only makes
 * the form close a few hundred milliseconds early or late, once, and the server remains the
 * authority on whether the vote is taken. Closure is also one-way here - this can only ever add
 * closure to what the server already said, never take it away.
 *
 * @param polls Reader for the polls on the card - a function, so the effect re-runs when the card
 *   is handed a different set (an edit, or a feed reusing the component for another post).
 * @returns An object whose `at` is the instant to pass to `pollDeadlinePassed`.
 */
export function pollDeadlineClock(polls: () => readonly PollDeadline[]) {
  let at = $state(Date.now());

  $effect(() => {
    const delay = msUntilPollDeadline(polls(), at);
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      at = Date.now();
    }, delay);
    return () => clearTimeout(timer);
  });

  return {
    get at() {
      return at;
    },
  };
}
