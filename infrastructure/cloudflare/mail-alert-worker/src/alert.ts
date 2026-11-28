/**
 * THE MAIL ALERT RELAY'S DECISION, PURE (mail lot 5, docs/wiki/mail-client-transport.md#as-built---lot-5).
 *
 * Partage sends the account's own new-mail alert to `n-<32 hex>@<alert domain>`. The only thing the
 * relay ever takes from that message is the TOKEN in the envelope recipient: no header, no subject,
 * no body is read, stored or forwarded. It posts `{token}` to Canari's hook with the estate's shared
 * secret, and the message itself is dropped (never forwarded, never rejected: a bounce would land in
 * the user's mailbox).
 */

/** The relay's settings: `TARGET_URL` and `ALERT_DOMAIN` are plain vars, `HOOK_SECRET` a Worker secret. */
export interface AlertEnv {
  TARGET_URL: string;
  ALERT_DOMAIN: string;
  HOOK_SECRET: string;
  /** Cloudflare's rate-limiting binding, keyed per token. */
  MAIL_ALERT_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/** The header Canari's hook reads the secret from (`MAIL_ALERT_SECRET_HEADER` server side). */
export const SECRET_HEADER = 'x-canari-mail-alert-secret';

/** The hook's path on the estate. */
export const HOOK_PATH = '/api/hooks/mail-alert';

/** What one alert came to, for the Worker's log. */
export type AlertOutcome =
  | 'posted'
  | 'not_ours'
  | 'rate_limited'
  | 'misconfigured'
  | 'refused'
  | 'unreachable';

const LOCAL_PART = /^n-([0-9a-f]{32})$/;

/**
 * The token of `recipient` when it is an address of Canari's shape ON this relay's domain, else
 * `null`. Case-insensitive, as mail addresses are.
 */
export function tokenOf(recipient: string, alertDomain: string): string | null {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  if (address.slice(at + 1) !== alertDomain.trim().toLowerCase()) return null;
  const match = LOCAL_PART.exec(address.slice(0, at));
  return match ? match[1] : null;
}

/** Handles one alert addressed to `recipient`: everything but the token is ignored. */
export async function relayAlert(
  recipient: string,
  env: AlertEnv,
  fetcher: typeof fetch = fetch
): Promise<AlertOutcome> {
  if (!env.HOOK_SECRET || !env.TARGET_URL || !env.ALERT_DOMAIN) {
    console.error('[mail-alert] misconfigured: HOOK_SECRET, TARGET_URL or ALERT_DOMAIN is missing');
    return 'misconfigured';
  }
  const token = tokenOf(recipient, env.ALERT_DOMAIN);
  if (!token) {
    console.warn('[mail-alert] dropped: the recipient is not an alert address of this relay');
    return 'not_ours';
  }
  const { success } = await env.MAIL_ALERT_LIMITER.limit({ key: token });
  if (!success) {
    console.warn('[mail-alert] dropped: this token is over its rate');
    return 'rate_limited';
  }
  try {
    const res = await fetcher(`${env.TARGET_URL.replace(/\/+$/, '')}${HOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: env.HOOK_SECRET },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      console.error(`[mail-alert] the hook refused the alert: status=${res.status}`);
      return 'refused';
    }
    return 'posted';
  } catch (err) {
    console.error(`[mail-alert] the hook is unreachable: ${String(err)}`);
    return 'unreachable';
  }
}
