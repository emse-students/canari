import { Logger } from '@nestjs/common';

/**
 * The origins Canari's own clients present, and the CORS predicate every service applies to them.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE `Set` IN `main.ts`: a Tauri WebView has no single origin,
 * it has one PER PLATFORM, and only the Android pair was ever written down. iOS serves the app from
 * `tauri://localhost` - which `frontend/src/lib/utils/apiUrl.ts` already states in prose - and that
 * matched nothing here. The failure was not a clean refusal either: a denied CORS layer lets the
 * PREFLIGHT fall through to a router that has no `OPTIONS` handler, so
 * `OPTIONS /api/auth/oidc/callback` answered 404, WebKit rejected the token exchange with
 * `TypeError: Load failed`, and the app showed "Echec de la connexion" with the deep link and the
 * authorization code both perfectly intact. Measured on prod 2026-08-27 at 20:10:46 UTC from an
 * iPhone running iOS 18.7. An origin list keyed by platform is a fact about the CLIENTS, so it is
 * named once and shared, never spelt inline at each of four bootstraps.
 *
 * DUPLICATED IN `core-service`, `social-service`, `media-service` AND `chat-delivery-service` ON
 * PURPOSE, byte for byte: there is no shared TypeScript package to hold it. `libs/shared-ts`
 * existed, was imported by nothing, and was deleted on 2026-08-27; creating one for this would add
 * a build stage and the `--install-links` trap to four production images. A change here is a change
 * in all four copies - the state this repo calls the worst a convention can be in is the one where
 * three of the four agree.
 */

/**
 * Every origin a Tauri WebView can present, by platform.
 *
 * Tauri v2 serves the bundled frontend over a custom protocol whose spelling is platform-specific:
 * a `tauri.localhost` HTTP tuple where the platform's WebView demands a standard scheme, and the
 * `tauri://` scheme itself on WebKit. All of them are this app talking to its own backend.
 */
export const TAURI_WEBVIEW_ORIGINS = [
  'http://tauri.localhost', // Android, Windows
  'https://tauri.localhost', // Android (Tauri v2 serves the asset protocol over https)
  'tauri://localhost', // iOS, macOS, Linux - WebKit keeps the custom scheme as the origin
] as const;

/**
 * Builds the exact-match origin allowlist: every Tauri WebView origin, plus the deployed frontend
 * when `FRONTEND_URL` names one.
 *
 * @param frontendUrl - Value of `FRONTEND_URL`; a trailing slash is stripped, empty is ignored.
 */
export function buildAllowedOrigins(frontendUrl: string | undefined): Set<string> {
  const allowed = new Set<string>(TAURI_WEBVIEW_ORIGINS);
  const frontend = (frontendUrl || '').replace(/\/+$/, '');
  if (frontend) allowed.add(frontend);
  return allowed;
}

/** Loopback origins on any port: Vite dev server, Tauri desktop dev, local tooling. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Decides whether `origin` may read a credentialed response from this service.
 *
 * @param origin - The request's `Origin` header. `undefined` means there is none.
 * @param allowed - Exact-match allowlist from {@link buildAllowedOrigins}.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  // No Origin at all is not a browser asking on someone's behalf: server-to-server, curl, health
  // checks. There is no cross-origin read to protect against, so there is nothing to refuse.
  if (!origin) return true;
  if (allowed.has(origin)) return true;
  return LOOPBACK_ORIGIN.test(origin);
}

const logger = new Logger('Cors');

/**
 * How many distinct denied origins are worth naming before the log is just an inventory of
 * whoever is scanning the internet today. The point of the line is to catch OUR client presenting
 * an origin nobody wrote down, and that population is three or four values wide.
 */
const DENIAL_LOG_BUDGET = 20;
const deniedOrigins = new Set<string>();

/**
 * Builds the `cors.origin` delegate for `app.enableCors`.
 *
 * A denial is LOGGED, once per distinct origin. Nothing else in the request tells anyone this
 * happened: the response is a well-formed 200 (or a 404, for a preflight that fell through to the
 * router) missing only its `Access-Control-Allow-Origin`, the browser reports a bare network error,
 * and the origin that was refused - the one fact that identifies the client - appears nowhere. That
 * silence is what let a whole platform's requests be dropped for as long as it took someone to
 * report it by hand.
 *
 * A denial is a `false`, NEVER an `Error`. An `Error` here is not a refusal but a THROW: Nest turns
 * it into a 500 for the entire request, including a public GET that needs no CORS at all - measured
 * on prod 2026-08-19, where `GET /api/media/public/:id` answered 500 to any request carrying an
 * unknown `Origin`. `false` omits the CORS headers instead, which blocks exactly the credentialed
 * cross-origin read it should while leaving the response correct for everything else.
 *
 * @param allowed - Exact-match allowlist from {@link buildAllowedOrigins}.
 */
export function corsOriginDelegate(
  allowed: Set<string>
): (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void {
  return (origin, callback) => {
    if (isAllowedOrigin(origin, allowed)) {
      callback(null, true);
      return;
    }
    if (origin && !deniedOrigins.has(origin) && deniedOrigins.size < DENIAL_LOG_BUDGET) {
      deniedOrigins.add(origin);
      logger.warn(
        `CORS DENIED origin "${origin}" - no Access-Control-Allow-Origin was sent, so a browser ` +
          `client sees a bare network failure (WebKit: "Load failed") and a preflight answers 404. ` +
          `If this is a Canari client, its origin belongs in TAURI_WEBVIEW_ORIGINS in all four ` +
          `services. Allowed here: ${[...allowed].join(', ')} plus http(s) loopback on any port.`
      );
    }
    callback(null, false);
  };
}
