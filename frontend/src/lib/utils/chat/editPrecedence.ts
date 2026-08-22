/**
 * Which of two edits of the same message wins, decided identically on every device.
 *
 * WHY THIS EXISTS. `edit_message` was applied on arrival, unconditionally, by all three paths that
 * apply one: the live handler, the history replay, and the sending device's own optimistic write.
 * "Whatever arrived last" is not a rule - it is a different answer per device, because two devices
 * receive in different orders. MUT-18 crossed two edits of one message from two devices of one
 * account and caught it: W1 ended on A1's text, A1 ended on W1's text, and neither ever moved again.
 * A silent, permanent disagreement about the content of a message, with no error anywhere.
 *
 * The pin register had already solved exactly this, one file away, and even wrote down the argument
 * (`pinStore.supersedes`): two devices must reach the same answer from the same pair, and "keep what
 * I had" depends on arrival order. This is that rule for edits.
 *
 * WHAT CONVERGENCE ACTUALLY REQUIRES, stated because it is the whole reason a wall clock is
 * acceptable here. It does not require the RIGHT winner - there is no such thing between two
 * concurrent edits - it requires the SAME winner everywhere. `editedAt` is stamped by the sending
 * device, so two skewed clocks change WHICH edit wins; they cannot make two devices disagree, because
 * every device decides from the same pair of (timestamp, content) values. Arbitrary-but-agreed is a
 * correct convergence rule; arrival order is not a rule at all.
 *
 * The tie is broken on the content because a tie needs a rule for the same reason the ordering does,
 * and content is the one field both devices are guaranteed to hold. It is arbitrary and total, which
 * is all that is asked of it.
 */

/** An edit as it arrives on the wire, or as a device is about to apply its own. */
export interface IncomingEdit {
  /** Unix ms, stamped by the device that made the edit. */
  editedAt: number;
  /** The replacement body. */
  content: string;
}

/** The edit a message already carries, if it carries one. `editedAt` is absent on unedited rows. */
export interface HeldEdit {
  editedAt?: Date | number | null;
  content: string;
}

/** Normalises the several shapes `editedAt` takes across memory (`Date`) and storage (number). */
function ms(at: Date | number | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const n = at instanceof Date ? at.getTime() : Number(at);
  return Number.isFinite(n) ? n : null;
}

/**
 * Does `next` supersede the edit `held` already carries?
 *
 * Strictly later wins. An undated held edit loses, because a row that carries no `editedAt` has no
 * edit to defend - and a frame from a client too old to send one is dated on arrival by its caller,
 * which is the best clock that frame has. A tie goes to the greater content string.
 */
export function editSupersedes(next: IncomingEdit, held: HeldEdit | undefined | null): boolean {
  if (!held) return true;
  const heldAt = ms(held.editedAt);
  if (heldAt === null) return true;
  const nextAt = ms(next.editedAt);
  if (nextAt === null) return false;
  if (nextAt !== heldAt) return nextAt > heldAt;
  return next.content > held.content;
}
