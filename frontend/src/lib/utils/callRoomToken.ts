/**
 * What a call's ROOM TOKEN says about the call, read on the client (WP-GC2).
 *
 * chat-delivery signs `max_seats` into every room token of a GROUP call (4 audio, 3 video, D-A) and
 * none into a 1:1 call's (`calls.service.ts`, `roomClaims`); call-service enforces it. It is the ONE
 * place the server says which kind of call a room is, so both ends read the kind from it - the
 * caller from the token `initiate` answered, a callee from the token `room-token` answered - and
 * cannot disagree: a call is a group call exactly when its token carries the claim.
 *
 * The signature is call-service's to check, never the client's (it holds no secret): this reads the
 * claim of a token our own server just handed us over TLS, as it would read a response field.
 */

/**
 * The version of the group-call protocol this build speaks (WP-GC2): 1 = the peer-to-peer mesh. Sent
 * on `initiate`, `room-token` and every push registration (`groupCallVersion`), so the server rings
 * for a group call, and hands a group call's token to, only a build that can carry one
 * (chat-delivery `GROUP_CALL_MESH_VERSION`).
 */
export const GROUP_CALL_VERSION = 1;

/** Thrown when a room token is not a JWT whose payload is JSON: the server's answer is unreadable. */
export class RoomTokenUnreadableError extends Error {
  constructor(detail: string) {
    super(`call room token unreadable: ${detail}`);
    this.name = 'RoomTokenUnreadableError';
  }
}

/** Decodes one base64url segment of a JWT to text. */
function base64UrlToText(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The seat cap a room token carries (`max_seats`), or `null` when it carries none - a 1:1 call.
 * THROWS {@link RoomTokenUnreadableError} for a token that is not a readable JWT, or a claim that is
 * not a whole number: guessing a kind would key the call wrongly on one end.
 */
export function roomTokenSeats(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) throw new RoomTokenUnreadableError(`${parts.length} segment(s)`);
  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlToText(parts[1]));
  } catch (e) {
    throw new RoomTokenUnreadableError(`payload: ${String(e)}`);
  }
  if (!claims || typeof claims !== 'object') throw new RoomTokenUnreadableError('payload');
  const seats = (claims as { max_seats?: unknown }).max_seats;
  if (seats === undefined || seats === null) return null;
  if (typeof seats !== 'number' || !Number.isInteger(seats)) {
    throw new RoomTokenUnreadableError(`max_seats=${String(seats)}`);
  }
  return seats;
}
