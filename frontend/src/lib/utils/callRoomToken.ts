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

/** The claims object of a room token. THROWS {@link RoomTokenUnreadableError} when there is none. */
function roomTokenClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new RoomTokenUnreadableError(`${parts.length} segment(s)`);
  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlToText(parts[1]));
  } catch (e) {
    throw new RoomTokenUnreadableError(`payload: ${String(e)}`);
  }
  if (!claims || typeof claims !== 'object') throw new RoomTokenUnreadableError('payload');
  return claims as Record<string, unknown>;
}

/**
 * The seat cap a room token carries (`max_seats`), or `null` when it carries none - a 1:1 call.
 * THROWS {@link RoomTokenUnreadableError} for a token that is not a readable JWT, or a claim that is
 * not a whole number: guessing a kind would key the call wrongly on one end.
 */
export function roomTokenSeats(token: string): number | null {
  const seats = roomTokenClaims(token).max_seats;
  if (seats === undefined || seats === null) return null;
  if (typeof seats !== 'number' || !Number.isInteger(seats)) {
    throw new RoomTokenUnreadableError(`max_seats=${String(seats)}`);
  }
  return seats;
}

/**
 * How a call's media travels, as call-service names its room modes (`RoomMode`): `p2p` - a 1:1 call
 * or the mesh, one peer connection per other participant - or `sfu`, one connection to the relay
 * carrying every participant (WP-GC4, `services/callSfuLeg.ts`).
 */
export type CallRoomMode = 'p2p' | 'sfu';

/**
 * The room mode a room token carries (WP-GC4 client). chat-delivery signs `mode: "sfu"` into every
 * token of a group call through the relay (`calls.service.ts`, `roomClaims`) and no `mode` otherwise,
 * and call-service refuses a `Join` in another mode than the token signs (`mode-mismatch`) - so the
 * client reads the mode it joins in HERE, from the token, and never from `platform_config.call_relay`.
 * THROWS {@link RoomTokenUnreadableError} for an unreadable token and for a mode this build does not
 * speak: joining the relay it does not know in another mode would only be refused one step later.
 */
export function roomTokenMode(token: string): CallRoomMode {
  const mode = roomTokenClaims(token).mode;
  if (mode === undefined || mode === null) return 'p2p';
  // call-service reads a signed `p2p` as the same room as no claim at all.
  if (mode === 'sfu' || mode === 'p2p') return mode;
  throw new RoomTokenUnreadableError(`mode=${String(mode)}`);
}
