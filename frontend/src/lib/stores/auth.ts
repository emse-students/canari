/**
 * Client-side auth store.
 *
 * Tokens are issued by core-service (POST /auth/login, POST /auth/refresh).
 * The frontend never signs or holds a JWT secret — it only stores the tokens
 * it receives from the backend.
 *
 * Access token  → kept in memory only (lost on page reload, recovered via refresh).
 * Refresh token → persisted in localStorage so sessions survive reloads.
 */

const REFRESH_KEY = 'canari_refresh_token';

let _accessToken: string | null = null;

function coreUrl(): string {
  const url = import.meta.env.VITE_CORE_URL as string | undefined;
  return url?.trim() || 'http://localhost:3000';
}

/**
 * Login with just a userId (dev phase).
 * The PIN is not involved in authentication — it is only used by the delivery
 * service to unlock the local MLS key package.
 */
export async function login(userId: string): Promise<string> {
  const res = await fetch(`${coreUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `Authentication failed (${res.status})`);
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string };
  _accessToken = data.access_token;
  localStorage.setItem(REFRESH_KEY, data.refresh_token);
  return data.access_token;
}

/** Rotate the access token using the stored refresh token. */
export async function refresh(): Promise<string> {
  const rt = localStorage.getItem(REFRESH_KEY);
  if (!rt) throw new Error('No refresh token — please log in again');

  const res = await fetch(`${coreUrl()}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  });

  if (!res.ok) {
    clearAuth();
    throw new Error('Session expired — please log in again');
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string };
  _accessToken = data.access_token;
  localStorage.setItem(REFRESH_KEY, data.refresh_token);
  return data.access_token;
}

/**
 * Returns the current access token, attempting a silent refresh if none is
 * held in memory (e.g. after a page reload in Tauri).
 */
export async function getToken(): Promise<string> {
  if (_accessToken) return _accessToken;
  return await refresh();
}

/** Override the in-memory token (used when a token is received externally). */
export function setToken(token: string): void {
  _accessToken = token;
}

export function clearAuth(): void {
  _accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
}

export function hasStoredSession(): boolean {
  return !!localStorage.getItem(REFRESH_KEY);
}
