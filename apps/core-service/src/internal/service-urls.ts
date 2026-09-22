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

 * AND `payment/social-internal-client.ts` IS WHY THIS FILE WAS ONLY HALF THE FIX. It kept its own
 * `getSocialServiceBase()`, so this service addressed social-service two ways at once, and its
 * webhook path read a THIRD name, `SOCIAL_SERVICE_URL`, which **production has never set for
 * core-service** - measured on the box 2026-09-22, where only `FORM_URL`, `FORM_SERVICE_URL` and
 * `MEDIA_SERVICE_URL` exist. That knob has done nothing since it was written: every call took the
 * literal default beside it, which happens to be the same host. A variable an operator can set and
 * that changes nothing is worse than no variable, because it answers a question wrongly.
 *
 * So there is one address per callee here now, and `service-urls.spec.ts` beside this file refuses
 * a second: a production source that so much as NAMES an internal base URL fails the suite,
 * whatever reads it - `process.env`, `ConfigService`, or the next thing somebody thinks of.
 *
 * WHY A FUNCTION AND NOT A LONGER ENV VAR: putting `/api` in the compose file fixes the deployment
 * and leaves the code's defaults wrong, and nothing would stop the next call site from omitting it.
 * Here the prefix is not the caller's to write.
 *
 * DUPLICATED IN `social-service` ON PURPOSE - see the note at the head of its copy. There is no
 * shared TypeScript package to put it in: `libs/shared-ts` existed, was imported by nothing, and was
 * deleted on 2026-08-27. Creating one for these four lines would add a build stage and the
 * `--install-links` trap to two more production images. The repo already duplicates
 * `internal-secret.util.ts` the same way.
 */

/** Every Nest service in this repo serves its routes under this prefix. See each `main.ts`. */
const GLOBAL_PREFIX = 'api';

/**
 * Rejects a base URL that is not a plausible internal service origin.
 *
 * INHERITED FROM `payment/webhook.controller.ts`, WHICH GUARDED TWO CALLS OUT OF NINE. It lived
 * there as `parseSafeServiceOrigin`, applied to the Stripe and Lydia fulfilment paths and to
 * nothing else; here it applies to every internal URL this service builds, which is the point of a
 * seam. Both checks are about an OPERATOR's mistake in a compose file - a value that is not an
 * origin at all, or one carrying credentials that would then be logged with the URL - and both
 * fail loudly at the first call rather than producing a request to somewhere unintended.
 *
 * ITS THIRD CHECK DID NOT SURVIVE, AND THAT IS DELIBERATE. It also refused a base with a path,
 * because it fed `new URL(path, origin)`, which silently drops one. This file concatenates instead,
 * and DOCUMENTS that a base already ending in `/api` is tolerated - an operator who "fixes" a 404
 * by appending the prefix must not produce `/api/api/...`. The two rules contradict each other;
 * keeping the one this file is built around is the only coherent choice, and the construction the
 * other rule protected is gone.
 */
function assertUsableBase(raw: string, envHint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${envHint} is not a URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envHint} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${envHint} must not include credentials`);
  }
}

/** Joins a service origin to a controller route, inserting the global prefix exactly once. */
function join(baseUrl: string, path: string, envHint: string): string {
  assertUsableBase(baseUrl, envHint);
  const base = baseUrl.replace(/\/+$/, '');
  const withPrefix = base.endsWith(`/${GLOBAL_PREFIX}`) ? base : `${base}/${GLOBAL_PREFIX}`;
  return `${withPrefix}/${path.replace(/^\/+/, '')}`;
}

/** A route on chat-delivery-service, reachable only over the Docker network. */
export function chatDeliveryUrl(path: string): string {
  return join(
    process.env.CHAT_DELIVERY_URL ?? 'http://chat-delivery-service:3010',
    path,
    'CHAT_DELIVERY_URL'
  );
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
    process.env.SOCIAL_URL ||
      process.env.FORM_URL ||
      process.env.FORM_SERVICE_URL ||
      'http://social-service:3014',
    path,
    'SOCIAL_URL/FORM_URL/FORM_SERVICE_URL'
  );
}

/** A route on media-service. Its controller is mounted at `media`, hence `media/...` in the path. */
export function mediaUrl(path: string): string {
  return join(
    process.env.MEDIA_SERVICE_URL ?? 'http://media-service:3011',
    path,
    'MEDIA_SERVICE_URL'
  );
}
