/**
 * AN ERROR WHOSE MESSAGE IS ALREADY THE READER'S SENTENCE, SAID AS A TYPE.
 *
 * Almost every `Error` in this application carries dev prose - an exception from a server, a
 * browser string like `Failed to fetch`, a line written for a log - and English is correct for all
 * of it. A handful carry the opposite: `changePinImpl` throws `new Error(m.auth_pin_change_current_
 * incorrect())`, and six sibling throws in `sessionAuth.ts` do the same, because "the PIN you typed
 * is not the current one" is a DISTINCTION the user must be told and a status cannot express.
 *
 * NOTHING IN `Error` SAYS WHICH KIND IT IS, so the modals rendering those PIN flows had to write
 * `e instanceof Error ? e.message : ...` and hope. That hope is load-bearing in both directions: a
 * `Failed to fetch` from the same `try` reached the PIN modal in English and read exactly like
 * "your PIN is wrong" (measured 2026-09-05, see `fetchOrUnreachable.ts`), and the cure everywhere
 * else - drop the preference, show the declared fallback - would here REPLACE six precise French
 * sentences with one vague one.
 *
 * So the rule that governs every other seam in this repository applies unchanged, in the one
 * direction it had not been applied yet: **classify at the THROW, as a type.** The type does not
 * say what went wrong - the message does that, in the reader's language. It says that the message
 * is FOR THE READER.
 *
 * {@link ServerUnreachableError} is the case that already worked this way and it becomes a subclass
 * rather than a sibling: its message is the caller's own Paraglide line, so it is exactly this
 * contract plus one more fact (we could not ask). `isServerUnreachable` keeps answering only for
 * that narrower kind.
 */
export class LocalizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalizedError';
  }
}

/**
 * The sentence to show for a rejection: the error's own, when the THROW marked it as the reader's.
 *
 * @param error Whatever was caught.
 * @param fallback The localized line this screen declares for everything else - which is most
 *   things, and is why it is required rather than optional.
 * @returns A sentence in the reader's language, never dev prose.
 */
export function localizedMessage(error: unknown, fallback: string): string {
  return error instanceof LocalizedError ? error.message : fallback;
}
