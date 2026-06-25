# Auth module

**Routes**: `src/routes/login/`, `src/routes/auth/callback/`  
**Components**: `src/lib/components/auth/`  
**Store**: `src/lib/stores/auth.svelte.ts`

## Responsibilities

- OIDC login via Authentik (redirect flow with PKCE).
- Dev login (email/password) when `ENABLE_DEV_ROUTES=true`.
- Access token management (in-memory only).
- Refresh token rotation via HttpOnly cookie.
- WebSocket auth cookie (`canari_ws_token`) synchronization.
- PIN setup and verification (used to encrypt MLS state).

## Login flow

```
/login -> startOidcLogin()
  -> redirect to Authentik /authorize (PKCE + state)
  -> callback to /auth/callback?code=...&state=...
  -> POST /api/auth/oidc/callback { code, redirect_uri }
  -> store access_token in memory
  -> set canari_ws_token cookie
  -> redirect to /chat
```

## Routes

| Route | Description |
|---|---|
| `/login` | Login page (OIDC button + optional dev form) |
| `/auth/callback` | Receives OIDC auth code, completes login |

## Auth store

```typescript
// auth.svelte.ts
export const currentUser: Writable<User | null>;
export const accessToken: Writable<string | null>;

export function setWsSessionCookie(token: string): void;
export function clearWsSessionCookie(): void;
export async function refreshAccessToken(): Promise<string | null>;
export async function logout(): Promise<void>;
```

`apiFetch.ts` intercepts 401 responses: it calls `refreshAccessToken()` once and retries. If refresh fails, it clears the session and redirects to `/login`.

## PIN

The PIN is used to derive the encryption key for the MLS WASM state persisted in IndexedDB. It is never sent to the server. PIN entry/confirmation happens in the login flow after OIDC authenticates the user.

Security endpoint: `POST /api/mls/security/pin-check` — the server stores a PBKDF2 verifier to detect PIN mismatches across devices (e.g. after reinstall).
