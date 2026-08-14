/**
 * WHERE THIS SERVICE REACHES ANOTHER ONE - so no call site has to remember the callee's prefix.
 *
 * Every Nest service in this monorepo mounts `app.setGlobalPrefix('api')` in its own `main.ts`, so a
 * route declared `@Controller('internal')` + `@Delete('users/:userId')` is served at
 * `/api/internal/users/:userId` and nowhere else. The internal base URLs are configured without it,
 * which left the prefix to each caller - and in `users.service.ts` three of the four forgot it:
 *
 *   - `DELETE <chat-delivery>/internal/users/<user>`   404. Account deletion left the user's MLS
 *     keys, devices and messages in place;
 *   - `DELETE <social>/internal/users/<user>`          404. Same, for posts, follows and
 *     memberships;
 *   - `GET <social>/internal/associations/<id>/member-user-ids`  404.
 *
 * All three are `.catch(warn)` best-effort, so a permanent 404 is indistinguishable from a service
 * being briefly down - which is why this survived: the failure mode of the code was designed for a
 * transient fault and met a permanent one.
 *
 * The fourth, `<media>/api/media/internal/users/<user>`, spelt the prefix inline and worked. So did
 * every path in `payment/social-internal-client.ts`. The convention was known and applied in two
 * places out of three, which is the worst state a convention can be in.
 *
 * WHY A FUNCTION AND NOT A LONGER ENV VAR: putting `/api` in the compose file fixes the deployment
 * and leaves the code's defaults wrong, and nothing would stop the next call site from omitting it.
 * Here the prefix is not the caller's to write.
 *
 * DUPLICATED IN `social-service` ON PURPOSE - see the note at the head of its copy. `libs/shared-ts`
 * is wired into `chat-delivery-service` alone, and adopting it here would add a build stage and the
 * `--install-links` trap to two more production images to save four lines. The repo already
 * duplicates `internal-secret.util.ts` the same way.
 */

/** Every Nest service in this repo serves its routes under this prefix. See each `main.ts`. */
const GLOBAL_PREFIX = 'api';

/** Joins a service origin to a controller route, inserting the global prefix exactly once. */
function join(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const withPrefix = base.endsWith(`/${GLOBAL_PREFIX}`) ? base : `${base}/${GLOBAL_PREFIX}`;
  return `${withPrefix}/${path.replace(/^\/+/, '')}`;
}

/** A route on chat-delivery-service, reachable only over the Docker network. */
export function chatDeliveryUrl(path: string): string {
  return join(process.env.CHAT_DELIVERY_URL ?? 'http://chat-delivery-service:3010', path);
}

/**
 * A route on social-service.
 *
 * `SOCIAL_URL` is read first for compatibility with what `users.service.ts` already used, then the
 * `FORM_*` pair that `payment/social-internal-client.ts` reads and that the compose files actually
 * set. Two names for one service is its own small mess; unifying them is a deployment change and is
 * deliberately NOT bundled with a correctness fix.
 */
export function socialUrl(path: string): string {
  return join(
    process.env.SOCIAL_URL || process.env.FORM_URL || process.env.FORM_SERVICE_URL ||
      'http://social-service:3014',
    path
  );
}

/** A route on media-service. Its controller is mounted at `media`, hence `media/...` in the path. */
export function mediaUrl(path: string): string {
  return join(process.env.MEDIA_SERVICE_URL ?? 'http://media-service:3011', path);
}
