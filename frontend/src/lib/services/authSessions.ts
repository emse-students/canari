/**
 * Client for the account-session API (`/api/auth/sessions`).
 *
 * A session here is a long-lived login - one browser, one phone, one desktop
 * app - and is NOT an MLS device: devices decide who can decrypt, sessions
 * decide who can obtain an access token. Revoking one leaves the other alone.
 *
 * The two are shown as ONE list, joined on {@link AuthSessionInfo.deviceId},
 * which is written by {@link bindCurrentSessionDevice} once per app start.
 * Nothing else joins them - a session lives in core-service, a device in the
 * delivery service - so before that write existed the settings screen had two
 * lists and no way to say which row on one was which row on the other.
 */

import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';

/** One live session of the current user, as returned by the server. */
export interface AuthSessionInfo {
  id: string;
  /** True for the session this browser/app is currently using. */
  current: boolean;
  /** ISO timestamps. */
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  userAgent: string | null;
  lastIp: string | null;
  /**
   * The MLS device this login belongs to, or null when it never said.
   *
   * Null is a state, not a gap: a session is opened by the OIDC callback,
   * before MLS is unlocked and can name a device, and a holder who cannot
   * unlock MLS at all - a stolen cookie - never names one. Such a row is
   * therefore the one worth looking at, and the panel gives it its own entry
   * rather than hiding it under a device.
   */
  deviceId: string | null;
}

/** What the UI needs to render a session row without re-parsing the User-Agent. */
export interface SessionDescription {
  /** Human label, e.g. "Chrome - Windows". */
  label: string;
  /** Drives the icon: a phone or a screen. */
  kind: 'mobile' | 'desktop';
}

/**
 * The session list is authenticated by the access token AND needs the refresh
 * cookie: only the cookie says which row is the current one. `credentials`
 * therefore has to be explicit - `apiFetch` does not send cookies by default.
 */
export async function fetchAuthSessions(): Promise<AuthSessionInfo[]> {
  console.log('[SESSIONS] Loading account sessions');
  const res = await apiFetch(`${coreUrl()}/api/auth/sessions`, {
    credentials: 'include',
  });
  if (!res.ok) {
    console.warn(`[SESSIONS] List failed (HTTP ${res.status})`);
    throw new Error(`Failed to list sessions (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { sessions: AuthSessionInfo[] };
  console.log(`[SESSIONS] ${data.sessions.length} live session(s)`);
  return data.sessions;
}

/** Revokes one session. Revoking the current one signs this client out. */
export async function revokeAuthSession(id: string): Promise<boolean> {
  console.log(`[SESSIONS] Revoking session ${id}`);
  const res = await apiFetch(`${coreUrl()}/api/auth/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    console.warn(`[SESSIONS] Revoke failed (HTTP ${res.status})`);
    throw new Error(`Failed to revoke session (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { ok: boolean };
  return data.ok;
}

/**
 * Records which MLS device this session belongs to.
 *
 * Called ONCE per app start, right after MLS unlock - the first moment the
 * client can name its own device. Deliberately not folded into the refresh
 * call: that is the app's cold-start critical section, and under Tauri a
 * custom header on it would add a CORS preflight to pay for a label.
 *
 * The server writes nothing when the session already names that device, so a
 * restart against a stamped session costs a read and no write.
 */
export async function bindCurrentSessionDevice(deviceId: string): Promise<void> {
  console.log(`[SESSIONS] Binding this session to device ${deviceId}`);
  const res = await apiFetch(`${coreUrl()}/api/auth/sessions/current/device`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) {
    throw new Error(`Failed to bind session to device (HTTP ${res.status})`);
  }
}

/** Revokes every session except the current one. Returns how many died. */
export async function revokeOtherAuthSessions(): Promise<number> {
  console.log('[SESSIONS] Revoking every other session');
  const res = await apiFetch(`${coreUrl()}/api/auth/sessions`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    console.warn(`[SESSIONS] Revoke-others failed (HTTP ${res.status})`);
    throw new Error(`Failed to revoke sessions (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { revoked: number };
  console.log(`[SESSIONS] ${data.revoked} session(s) revoked`);
  return data.revoked;
}

/**
 * Turns a raw User-Agent into something a person can recognise.
 *
 * Deliberately coarse: the string only has to let its owner answer "is one of
 * these not me?", so it names a browser and a platform and stops there. Order
 * matters in both tables - every Chromium browser also says "Chrome", and every
 * iPad says "Macintosh" in desktop mode - so the more specific token is tested
 * first.
 */
export function describeUserAgent(
  userAgent: string | null,
  unknownLabel: string
): SessionDescription {
  const ua = userAgent?.trim();
  if (!ua) return { label: unknownLabel, kind: 'desktop' };

  const platforms: Array<[RegExp, string, 'mobile' | 'desktop']> = [
    [/\bAndroid\b/i, 'Android', 'mobile'],
    [/\b(iPhone|iPod)\b/i, 'iPhone', 'mobile'],
    [/\biPad\b/i, 'iPad', 'mobile'],
    [/\bWindows\b/i, 'Windows', 'desktop'],
    [/\b(Mac OS X|Macintosh)\b/i, 'macOS', 'desktop'],
    [/\bCrOS\b/i, 'ChromeOS', 'desktop'],
    [/\bLinux\b/i, 'Linux', 'desktop'],
  ];
  const browsers: Array<[RegExp, string]> = [
    [/\bEdgA?\//i, 'Edge'],
    [/\bOPR\//i, 'Opera'],
    [/\bSamsungBrowser\//i, 'Samsung Internet'],
    [/\bFirefox\//i, 'Firefox'],
    [/\bChrome\//i, 'Chrome'],
    [/\bSafari\//i, 'Safari'],
  ];

  const platform = platforms.find(([re]) => re.test(ua));
  const browser = browsers.find(([re]) => re.test(ua));

  const parts = [browser?.[1], platform?.[1]].filter(Boolean) as string[];
  return {
    label: parts.length > 0 ? parts.join(' - ') : unknownLabel,
    kind: platform?.[2] ?? 'desktop',
  };
}
