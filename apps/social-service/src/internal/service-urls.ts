/**
 * WHERE THIS SERVICE REACHES ANOTHER ONE - so no call site has to remember the callee's prefix.
 *
 * Every Nest service in this monorepo mounts `app.setGlobalPrefix('api')` in its own `main.ts`. A
 * route declared `@Controller('internal')` + `@Post('push/notify')` is therefore served at
 * `/api/internal/push/notify` and nowhere else. The internal base URLs are configured WITHOUT that
 * prefix (`DELIVERY_INTERNAL_URL: http://chat-delivery-service:3010`), which left it to each caller.
 *
 * ALL THREE CALLERS IN THIS SERVICE GOT IT WRONG, and the failures were silent by construction:
 *
 *   - `POST /internal/push/notify` from `channel.service.ts` answered 404 on EVERY channel message,
 *     so channel push notifications had never once been delivered. It logged `WARN` and returned;
 *   - the same call from `push.service.ts`, same result;
 *   - `GET /mls/devices/<user>` answered 404, and `userHasMlsDevices` returned `true` on `!res.ok` -
 *     so a guard meant to stop inviting a user with no MLS device was a constant `true`. Not a
 *     degraded check: no check at all. **The prefix was fixed here; the fail-open half survived it
 *     until 2026-08-19**, and that is the lesson worth keeping - correcting the URL made the guard
 *     work again without making it capable of reporting that it had not. It now goes through
 *     [delivery.client](delivery.client.ts), which throws on anything but a 2xx.
 *
 * Measured on production 2026-08-14 from the delivery service's own logs, during the MSG phase of
 * the cross-client campaign - which is what a server-side observer buys.
 *
 * AND THE PREFIX WAS ONLY HALF OF THAT THIRD ONE. `mls/devices/<user>` is served behind
 * `HeaderAuthGuard`, so once the URL was right the route answered 401 rather than 404 - a service
 * calling a route addressed to users, with the only credential it has. It fails closed since
 * 2026-08-19, which turned every direct invitation on production into a 503 until COMM-4 asked for
 * one on 2026-08-20. `fetchUserDeviceCount` now calls `internal/mls/devices/<user>/count`. **A
 * URL is not an address until the credential fits it**, and a caller that guesses a callee's
 * route is guessing its guard too.
 *
 * WHY A FUNCTION AND NOT A LONGER ENV VAR. Putting `/api` in the compose file fixes the deployment
 * and leaves the code's defaults wrong, so a service started without the variable still 404s, and
 * nothing stops the next call site from omitting it again. Here the prefix is not the caller's to
 * write.
 *
 * The trailing-slash and already-suffixed handling is not decoration: the variable is operator-set,
 * and an operator who "fixes" it by appending `/api` must not produce `/api/api/internal/...`.
 *
 * DUPLICATED IN `core-service` ON PURPOSE. The obvious home is `libs/shared-ts`, but that package is
 * wired into `chat-delivery-service` alone (Dockerfile + jest moduleNameMapper); adopting it here
 * would add a `file:` dependency, a build stage and the `--install-links` trap to two more
 * production images to save four lines. The repo already duplicates `internal-secret.util.ts` the
 * same way, for the same reason.
 */

/** Every Nest service in this repo serves its routes under this prefix. See each `main.ts`. */
const GLOBAL_PREFIX = 'api';

/**
 * How long this service waits on any internal call before giving up, in milliseconds.
 *
 * ONE CONSTANT FOR EVERY CALLER, on purpose - the same discipline WP-AVATAR-1 settled on for the
 * avatar proxies. A budget spelled out at each call site is a budget that drifts, and it had: the
 * four `deliveryUrl` callers carried 4 s, 4 s, 5 s and 5 s, with nothing recording why they
 * differed. These are Docker-network hops, so the value is generous either way and what matters is
 * that it is one value. Anything slower than this is a failure worth surfacing, not waiting out.
 */
export const DELIVERY_TIMEOUT_MS = 5_000;

/** Joins a service origin to a controller route, inserting the global prefix exactly once. */
function join(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const withPrefix = base.endsWith(`/${GLOBAL_PREFIX}`) ? base : `${base}/${GLOBAL_PREFIX}`;
  return `${withPrefix}/${path.replace(/^\/+/, '')}`;
}

/**
 * A route on chat-delivery-service, reachable only over the Docker network.
 *
 * @param path the route as its controller declares it, e.g. `internal/push/notify`
 */
export function deliveryUrl(path: string): string {
  return join(process.env.DELIVERY_INTERNAL_URL ?? 'http://chat-delivery-service:3010', path);
}
