import { Logger } from '@nestjs/common';
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';

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
 * Builds the exact-match origin allowlist: every Tauri WebView origin, the deployed frontend(s)
 * named in `FRONTEND_URL`, and the origins the estate lists in `ALLOW_ORIGIN` where it hands this
 * service that list.
 *
 * THE LIST IS EXACT, AND NO ORIGIN IS ACCEPTED BY ITS SHAPE. A loopback origin (the Vite dev
 * server, Tauri desktop dev) is one of this app's clients only on an estate that names it: the
 * local and dev compose files pass `ALLOW_ORIGIN`, which spells the dev-server pair out;
 * production passes none, so no loopback origin is accepted there.
 *
 * Both values are comma-separated lists, the idiom `chat-gateway` reads `ALLOW_ORIGIN` with
 * (`main.rs`, `parse_allowed_origins`): both describe the same fact, which web origins are really
 * this app. A single URL with no comma still works.
 *
 * @param frontendUrl - Value of `FRONTEND_URL`; each segment's trailing slash is stripped, blank
 * segments (including an unset variable) are dropped.
 * @param estateOrigins - Value of `ALLOW_ORIGIN`, read the same way. A `*` segment is no origin a
 * browser sends, so it matches nothing: a wildcard is never a list.
 */
export function buildAllowedOrigins(
  frontendUrl: string | undefined,
  estateOrigins?: string
): Set<string> {
  const allowed = new Set<string>(TAURI_WEBVIEW_ORIGINS);
  for (const part of `${frontendUrl ?? ''},${estateOrigins ?? ''}`.split(',')) {
    const origin = part.trim().replace(/\/+$/, '');
    if (origin) allowed.add(origin);
  }
  return allowed;
}

/**
 * Decides whether `origin` may read a credentialed response from this service: it must be one of
 * `allowed`, compared as the browser serialises it.
 *
 * @param origin - The request's `Origin` header. `undefined` means there is none.
 * @param allowed - Exact-match allowlist from {@link buildAllowedOrigins}.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  // No Origin at all is not a browser asking on someone's behalf: server-to-server, curl, health
  // checks. There is no cross-origin read to protect against, so there is nothing to refuse.
  if (!origin) return true;
  return allowed.has(origin);
}

const logger = new Logger('Cors');

/**
 * The paths whose CORS answer belongs to the edge nginx and not to the service: `location
 * /api/public/` hides this service's `Access-Control-Allow-*` headers and sends
 * `Access-Control-Allow-Origin: *` itself (`infrastructure/local/Dockerfile.frontend`). The service's
 * verdict on an origin is invisible there, so a `CORS DENIED` line for such a path claims a browser
 * failure that cannot happen. The line is skipped by construction for these prefixes, never demoted:
 * on every other route it is a real refusal.
 */
export const EDGE_OWNED_CORS_PREFIXES = ['/api/public/'] as const;

/**
 * True when the edge nginx, not this service, decides the CORS answer for `url`. A path nginx would
 * normalise to a public one (`//api/public/x`, `/api/%70ublic/x`) is NOT recognised here and still
 * logs a denial: the safe direction, since a missed skip is noise and a wrong skip hides a refusal.
 */
export function isEdgeOwnedCorsPath(url: string | undefined): boolean {
  if (!url) return false;
  // nginx normalises `..` and percent-encoded dots and slashes before choosing a location, so a
  // crafted path could LOOK like a public one here while the edge answers it as another route:
  // such a path never silences the line for itself.
  if (url.includes('..') || url.includes('\\') || /%2[ef]|%5c/i.test(url)) return false;
  return EDGE_OWNED_CORS_PREFIXES.some((prefix) => url.startsWith(prefix));
}

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
 * @param edgeOwned - The request's path is one the edge nginx answers CORS for: the verdict is
 *   still computed (the headers are hidden by nginx anyway) but a denial is not logged, because it
 *   names no failure.
 */
export function corsOriginDelegate(
  allowed: Set<string>,
  edgeOwned = false
): (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void {
  return (origin, callback) => {
    if (isAllowedOrigin(origin, allowed)) {
      callback(null, true);
      return;
    }
    if (
      !edgeOwned &&
      origin &&
      !deniedOrigins.has(origin) &&
      deniedOrigins.size < DENIAL_LOG_BUDGET
    ) {
      deniedOrigins.add(origin);
      logger.warn(
        `CORS DENIED origin "${origin}" - no Access-Control-Allow-Origin was sent, so a browser ` +
          `client sees a bare network failure (WebKit: "Load failed") and a preflight answers 404. ` +
          `If this is a Canari client, its origin belongs in TAURI_WEBVIEW_ORIGINS in all four ` +
          `services, or in this estate's own list. Allowed here: ${[...allowed].join(', ')}.`
      );
    }
    callback(null, false);
  };
}

/**
 * How long a browser may reuse an answered preflight, in seconds. Chromium caps it at 2 h and WebKit
 * at 10 min. Without it Chromium keeps a preflight 5 s, so every read the phone apps make through
 * the WebView (`frontend/src/lib/utils/fetchRouting.ts`) to a new URL paid one more round trip.
 * The chat gateway's `CORS_PREFLIGHT_MAX_AGE` is the same value.
 */
export const CORS_PREFLIGHT_MAX_AGE_S = 7200;

/**
 * The per-request options DELEGATE every service hands `app.enableCors`: for each request it answers
 * the allowlist, credentials, the preflight cache and the response headers THIS service's clients read
 * beyond the safelisted ones. It is a delegate (not a plain object) because the denial log depends on
 * the request path, see {@link isEdgeOwnedCorsPath}.
 *
 * `allowedHeaders` IS ABSENT ON PURPOSE: the `cors` package then names back exactly the headers the
 * preflight asked for. A `*` would NOT cover `Authorization` (Fetch standard), and every phone read
 * carries a Bearer token.
 *
 * @param allowed - Exact-match allowlist from {@link buildAllowedOrigins}.
 * @param exposedHeaders - Response headers a cross-origin client must be able to read; a header left
 *   out reads as `null` on the phone apps, with no error anywhere.
 */
export function corsOptions(
  allowed: Set<string>,
  exposedHeaders: string[] = []
): CorsOptionsDelegate<CorsRequest> {
  return (req, callback) => {
    callback(null, {
      origin: corsOriginDelegate(allowed, isEdgeOwnedCorsPath(req.originalUrl ?? req.url)),
      credentials: true,
      maxAge: CORS_PREFLIGHT_MAX_AGE_S,
      ...(exposedHeaders.length > 0 && { exposedHeaders }),
    } satisfies CorsOptions);
  };
}

/** The part of the HTTP request {@link corsOptions} reads: the path, before and after Nest's prefix. */
export interface CorsRequest {
  originalUrl?: string;
  url?: string;
}
