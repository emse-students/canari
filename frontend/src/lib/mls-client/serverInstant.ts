/**
 * AN INSTANT THE SERVER HOLDS FOR A DERIVED LINE, AND THE FOUR ANSWERS IT CAN GIVE.
 *
 * A line this device derives rather than receives - "X added a device", "you were removed" - is
 * dated by the server's record of the event (a commit log row, a closed membership stretch), never
 * by when this device found out. Asking for that record has four ANSWERS, classified at the throw
 * as a type so no caller reads a status code or a message:
 *
 * - `at`: the instant.
 * - `none`: the server holds no record - the line has no date and will never get one (settled).
 * - `refused` (403): the server will not say (this device left the group, or the commit predates its
 *   arrival) - an answer too, and settled: asking again can only be refused again.
 * - `unserved` (404): this server does not serve the route at all - a build that shipped before its
 *   backend. Neither instant route ever answers 404 itself, so the status names the deployment. The
 *   line is PARKED (owed, not asked again this session) rather than retried on every drain.
 *
 * Anything else - no answer, a 5xx, a 429 - says nothing about the record and is THROWN: the caller
 * keeps the line owed to the next delivery.
 */
export type ServerInstant =
  | { kind: 'at'; at: number }
  | { kind: 'none' }
  | { kind: 'refused' }
  | { kind: 'unserved' };

/**
 * Reads one instant route's response into a {@link ServerInstant}, or `null` when the status is not
 * one of its answers (the caller throws it as the refusal it is).
 *
 * @param field the JSON field carrying the ISO instant (`acceptedAt`, `removedAt`)
 */
export async function readServerInstant(
  res: Response,
  field: string
): Promise<ServerInstant | null> {
  if (res.status === 403) return { kind: 'refused' };
  if (res.status === 404) return { kind: 'unserved' };
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown>;
  const raw = body[field];
  if (raw === null || raw === undefined) return { kind: 'none' };
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at) || at <= 0) {
    throw new Error(`${field}: unparseable instant ${String(raw).slice(0, 40)}`);
  }
  return { kind: 'at', at };
}

/**
 * Asks commit instants through `fetch` once per `(groupId, baseEpoch)` for the session.
 *
 * A log row is written once and never changes, so an `at` or a `none` is kept for good, and a drain
 * that re-derives its lines does not re-ask. A `refused` is not kept: it answers about this device's
 * membership, which a re-add changes. An `unserved` stops every later ask - the route is missing on
 * this server, not for this commit - and is said ONCE, at ERROR, instead of once per line per drain.
 */
export function cachedCommitInstants(
  fetch: (groupId: string, baseEpoch: number) => Promise<ServerInstant>
): (groupId: string, baseEpoch: number) => Promise<ServerInstant> {
  const known = new Map<string, ServerInstant>();
  let unserved = false;
  return async (groupId, baseEpoch) => {
    if (unserved) return { kind: 'unserved' };
    const key = `${groupId}:${baseEpoch}`;
    const cached = known.get(key);
    if (cached) return cached;
    const answer = await fetch(groupId, baseEpoch);
    if (answer.kind === 'unserved') {
      unserved = true;
      console.error(
        '[COMMIT_AT] the delivery service does not serve GET /api/mls/commits/:groupId/accepted-at (404) - this build shipped before its backend; device lines stay owed and are not asked again this session'
      );
    } else if (answer.kind !== 'refused') {
      known.set(key, answer);
    }
    return answer;
  };
}
