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
  /**
   * The server's finer `reason` beside its `code`, when the body carried one (a refused membership
   * report names `no_seat`, `kicked` or `not_on_roster`); null otherwise. Logged, never branched on
   * by a screen.
   */
  readonly reason: string | null;
  /**
   * How long the server asked to be left alone, in ms, when a `429` said so in its body
   * (`retryAfterMs`); null otherwise.
   */
  readonly retryAfterMs: number | null;

  constructor(
    /** The HTTP status the server answered with. */
    readonly status: number,
    /** The server's stable error code, or null when the body carried none. */
    readonly code: string | null,
    message: string,
    details: { reason?: string | null; retryAfterMs?: number | null } = {}
  ) {
    super(message);
    this.name = 'ApiRefusalError';
    this.reason = details.reason ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

/**
 * TYPES A REFUSED RESPONSE AT THE THROW: the status always, the server's stable `code` when its JSON
 * body carries a string one (Nest serialises `{ code, message }` as the body itself), and its
 * `reason` and `retryAfterMs` when present. The ONE
 * implementation for every endpoint that used to `throw new Error('... failed (' + status + ')')`,
 * which spelt the number into a sentence nobody could read back.
 *
 * `message` is dev-facing and English (a log line), never display copy - a screen words the refusal
 * from the status and code. A body that is not JSON (an edge page) carries no code. The body is read
 * from a CLONE, so a caller that still wants it (`res.text()`) is not starved.
 *
 * @param res The refused response.
 * @param message What was being attempted, for the log; the status is appended.
 */
export async function refusalFromResponse(
  res: Response,
  message: string
): Promise<ApiRefusalError> {
  let code: string | null = null;
  let reason: string | null = null;
  let retryAfterMs: number | null = null;
  try {
    const parsed: unknown = await res.clone().json();
    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>;
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.reason === 'string') reason = body.reason;
      if (typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)) {
        retryAfterMs = Math.max(0, body.retryAfterMs);
      }
    }
  } catch {
    // Not JSON (or already consumed): the refusal then has no machine-readable name, only a status.
  }
  return new ApiRefusalError(res.status, code, `${message} (${res.status})`, {
    reason,
    retryAfterMs,
  });
}
