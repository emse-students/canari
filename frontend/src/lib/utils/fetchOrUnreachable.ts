/**
 * `fetch`, with a NOT-REACHED turned into the same sentence a BAD ANSWER already gets.
 *
 * **A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT** - and the three PIN calls handled only
 * the first. `if (!res.ok) throw new Error(m.auth_pin_salt_unreachable())` covers a server that
 * replied badly; a server that could not be reached at all makes `fetch` itself REJECT, and that
 * rejection walked straight past to the outer catch, whose `msg` becomes the text in the modal. So
 * the person at the gate was shown `Failed to fetch` - an untranslated browser string, on a screen
 * whose every other word is French, and one that reads exactly like "your PIN is wrong".
 *
 * Measured by `pinrows.mjs --row 8` on 2026-09-05, with the network cut under the client:
 * `refusal: "Failed to fetch"`. The row's own question - does a dead radio end the session - was
 * answered `PASS`, which is why this needed a row that reads what the product SAID and not only what
 * it did.
 *
 * The message is the CALLER's, because the two calls mean different things to a reader ("could not
 * fetch the salt" and "could not check the PIN"), and both already exist in Paraglide.
 *
 * IT THROWS A TYPE, NEVER A SENTENCE. The first draft threw a bare `Error` carrying the localized
 * text, and that lost the one fact worth keeping: everything downstream could then see WHAT the user
 * would read and nothing at all about WHY. `sessionAuth`'s catch immediately needed it back - a
 * server that cannot be reached is not this application failing, and logging it as one puts a train
 * tunnel in the same bucket as a WASM build that will not load. **Classify at the THROW, as a
 * type**, and let each layer map it into its own vocabulary.
 *
 * IT PASSES A BAD ANSWER STRAIGHT THROUGH, which is the half that must not drift: a 401, a 404 and a
 * 500 are answers, they belong to the `!res.ok` branch at each call site, and a wrapper that started
 * turning them into "server unreachable" would erase the distinction it exists to draw.
 *
 * IT LIVES IN ITS OWN FILE so it can be executed by a test. `sessionAuth.ts` cannot be imported by
 * one - it is a several-hundred-line flow over a dozen module-level dependencies, which is why
 * `offlineUnlock.test.ts` reads it as TEXT and pins its decisions as source guards. A wrapper whose
 * whole content is a `try` around one call deserves better than a guard that greps for a keyword.
 */
export class ServerUnreachableError extends Error {
  constructor(
    message: string,
    /** The rejection `fetch` produced - kept for the log, never for the screen. */
    readonly cause: unknown
  ) {
    super(message);
    this.name = 'ServerUnreachableError';
  }
}

/** True when a rejection means "we could not ASK", rather than "we asked and were told no". */
export function isServerUnreachable(e: unknown): boolean {
  return e instanceof ServerUnreachableError;
}

export async function fetchOrUnreachable(
  url: string,
  init: RequestInit,
  unreachable: string
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: unknown) {
    // ACCUSED IN THE CONSOLE, EXPLAINED ON SCREEN. The raw cause is the only thing that tells a
    // developer which host was unreachable, and it is exactly what a user must not be shown.
    console.warn(`[fetch] ${url.replace(/\?.*$/, '')} could not be reached:`, e);
    throw new ServerUnreachableError(unreachable, e);
  }
}
