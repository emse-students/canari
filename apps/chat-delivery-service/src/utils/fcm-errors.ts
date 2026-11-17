/**
 * The ONE classifier of what `getMessaging().send()` threw, read from the structured `code` the
 * Firebase Admin SDK sets at the throw (`FirebaseMessagingError.code`, e.g.
 * `messaging/registration-token-not-registered`) - never from the error's prose.
 *
 * WHY HERE: the ring path once decided on `String(e).includes('registration-token-not-registered')`,
 * and a real `FirebaseMessagingError` stringifies to `Error: <message>` ("Requested entity was not
 * found."), which never carries the code - so a dead token was never removed by a ring. It also
 * dropped a token on a bare `invalid-argument`, which the v1 endpoint returns for a malformed
 * PAYLOAD too: a destructive control needs an allowlist of what it may touch, and that one was not.
 */

/** The `messaging/*` code an FCM send failure carries, or `null` when the throw carries none. */
export function fcmErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * The ALLOWLIST of codes meaning the TOKEN itself is gone for good, so its row may be deleted. No
 * other code may delete one: a network, quota or payload failure leaves a working device unreachable
 * until it re-registers, if it ever does.
 */
const TERMINAL_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

/** Whether FCM refused the send because the registration token is invalid or unregistered. */
export function isTerminalPushTokenError(error: unknown): boolean {
  const code = fcmErrorCode(error);
  return code !== null && TERMINAL_TOKEN_CODES.has(code);
}

/**
 * Codes that blame OUR configuration, never the device's token: the service account FCM rejected
 * (`authentication-error`), a credential that is not the one the token was issued to
 * (`mismatched-credential`), the APNs key or certificate Firebase holds for us
 * (`third-party-auth-error`). Every device fails the same way until a human fixes the project, so
 * each is an ERROR, and none may delete a token.
 */
const OUR_MISCONFIGURATION_CODES: ReadonlySet<string> = new Set([
  'messaging/authentication-error',
  'messaging/mismatched-credential',
  'messaging/third-party-auth-error',
]);

/**
 * How to log one failed FCM send: the level it deserves, and the tail of the line - the code as
 * evidence. Each call site writes `FCM failed user=... device=... <text>`, the shape the
 * cross-client rig's classifier (`srvlog.mjs`) matches on.
 */
export interface FcmFailureReport {
  level: 'error' | 'warn';
  text: string;
}

/**
 * The ONE log line of a failed FCM send, for every push path (ring, message, welcome, social).
 * It always names the structured code (`code=none` when the throw carried none), because the
 * prose alone (`Error: Requested entity was not found.`) is what the logs held before, and a
 * question like "how many sends failed with `invalid-argument`" could not be answered from it.
 */
export function describeFcmFailure(error: unknown): FcmFailureReport {
  const code = fcmErrorCode(error) ?? 'none';
  if (OUR_MISCONFIGURATION_CODES.has(code)) {
    return {
      level: 'error',
      text: `code=${code} - OUR credentials were refused: Canari's Firebase/APNs configuration, not this device's token - err=${String(error)}`,
    };
  }
  return { level: 'warn', text: `code=${code} err=${String(error)}` };
}
