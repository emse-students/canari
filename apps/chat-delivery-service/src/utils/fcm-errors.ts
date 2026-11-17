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
