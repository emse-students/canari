/**
 * ONE CALL TO MICONNECT'S (authentik's) API with a service account's token - the transport both of
 * core-service's MiConnect accounts share: the profile editor (`users/miconnect-editor.client.ts`)
 * and the handoff reader (`auth/handoff/miconnect-reader.client.ts`).
 *
 * It answers a TYPE, never throws: `ok` with the JSON body, `status` with the HTTP status MiConnect
 * gave (an answer), or `transport` when nothing came back (no answer). Each caller turns that into
 * its own typed refusal, so the distinction is made here, at the throw, and never re-read from a
 * message.
 */
export type AuthentikAnswer<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'status'; status: number }
  | { kind: 'transport'; error: string };

/** How long a MiConnect call may take before it counts as no answer. */
export const AUTHENTIK_TIMEOUT_MS = 10_000;

/** Calls `url` with `token` as a Bearer; `body`, when given, is sent as JSON. */
export async function authentikRequest<T>(
  method: string,
  url: string,
  token: string,
  body?: unknown
): Promise<AuthentikAnswer<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(AUTHENTIK_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'transport', error: String(err) };
  }
  if (!res.ok) return { kind: 'status', status: res.status };
  try {
    return { kind: 'ok', body: (await res.json()) as T };
  } catch {
    // A 2xx whose body is not JSON: MiConnect answered, but not with what was asked.
    return { kind: 'status', status: res.status };
  }
}
