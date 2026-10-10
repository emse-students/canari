// THE CLASS ALONE, with no Paraglide import: `apiRefusal.ts` pulls the whole message catalogue
// (thousands of generated modules), and a data-layer module that only needs to EXTEND the type
// (`SocialApiError`) must not pay that on every import - its tests re-import it per case.

/**
 * A REFUSAL THE SERVER ANSWERED, carrying the STATUS instead of spelling it into a sentence.
 *
 * Three throws had grown the same shape in three places - `ChannelApiError`, `CallInitiateError`,
 * and the media upload's four `!res.ok` sites, which had no class at all and spelt the status into
 * the message. They exist for one reason and are read one way: a screen catches the error, wants
 * the number, and must not show the sentence.
 *
 * SO THE NUMBER IS THE TYPE. A subclass then says only WHICH endpoint refused, which is what lets
 * `describeCallFailure` answer a 404 differently from every other caller while both read the
 * status through the same accessor. Five call sites had written
 * `e instanceof SomeApiError ? e.status : null` by hand, each one naming a service it otherwise
 * had no reason to import - `chat/messaging.ts` pulled 1030 lines of `ChannelService` into the
 * send path for the type alone.
 *
 * `code` sits on the base rather than on `ChannelApiError` because it answers the same question
 * one step more precisely: the stable name the server chose, when it chose one. An endpoint that
 * names nothing passes `null`, which means "this refusal has no machine-readable name" and must
 * never be treated as a match.
 */
export class ApiRefusalError extends Error {
  constructor(
    /** The HTTP status the server answered with. */
    readonly status: number,
    /** The server's stable error code, or null when the body carried none. */
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'ApiRefusalError';
  }
}
