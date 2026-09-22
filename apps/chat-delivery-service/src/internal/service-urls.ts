/**
 * WHERE THIS SERVICE REACHES ANOTHER ONE - so no call site has to remember the callee's prefix.
 *
 * Every Nest service in this monorepo mounts `app.setGlobalPrefix('api')` in its own `main.ts`,
 * and none of the `*_SERVICE_URL` variables carries that prefix. Getting it wrong is a 404 from
 * Express's unknown-route handler rather than from the callee's own code, which is the quietest
 * failure this repository knows how to produce: social-service shipped it four times, and the
 * fourth left **11 of 11 association posts previewing with a blank image in every unfurler** for
 * two days before anybody read the URL rather than the status.
 *
 * THE THREE CALL SITES THIS FILE REPLACED WERE ALL CORRECT, and that is the reason to write it
 * anyway. A convention that holds in three services out of four is not a convention, it is three
 * coincidences: the next caller here has nothing to copy from and one more chance to omit four
 * characters. `service-urls.spec.ts` beside this file is what makes it hold - a production source
 * that names an internal base URL fails the suite, whatever reads it.
 *
 * WHY A FUNCTION AND NOT A LONGER ENV VAR. Putting `/api` in the compose file fixes the deployment
 * and leaves the code's defaults wrong, so a service started without the variable still 404s, and
 * nothing stops the next call site from omitting it again. Here the prefix is not the caller's to
 * write.
 *
 * The trailing-slash and already-suffixed handling is not decoration: the variable is operator-set,
 * and an operator who "fixes" it by appending `/api` must not produce `/api/api/media/...`.
 *
 * DUPLICATED IN `social-service` AND `core-service` ON PURPOSE - see the note at the head of
 * social-service's copy. There is no shared TypeScript package to put it in: `libs/shared-ts`
 * existed, was imported by nothing, and was deleted on 2026-08-27. Creating one for these few
 * lines would add a `file:` dependency, a build stage and the `--install-links` trap to three
 * production images. The repo already duplicates `internal-secret.util.ts` the same way.
 */

/** Every Nest service in this repo serves its routes under this prefix. See each `main.ts`. */
const GLOBAL_PREFIX = 'api';

/** Joins a service origin to a controller route, inserting the global prefix exactly once. */
function join(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const withPrefix = base.endsWith(`/${GLOBAL_PREFIX}`) ? base : `${base}/${GLOBAL_PREFIX}`;
  return `${withPrefix}/${path.replace(/^\/+/, '')}`;
}

/**
 * A route on media-service, reachable only over the Docker network.
 *
 * @param path the route as its controller declares it, e.g. `media/internal/<id>`
 */
export function mediaUrl(path: string): string {
  return join(process.env.MEDIA_SERVICE_URL ?? 'http://media-service:3011', path);
}

/**
 * A route on core-service, reachable only over the Docker network.
 *
 * `CORE_SERVICE_INTERNAL_URL` is this service's own name for it; social-service calls the same box
 * `PAYMENT_SERVICE_URL` and `USER_SERVICE_URL`. Three names for one service is its own small mess,
 * and unifying them is a deployment change deliberately not bundled with a correctness fix - the
 * same call core-service's copy made about `SOCIAL_URL`/`FORM_URL`.
 *
 * @param path the route as its controller declares it, e.g. `users/<id>/avatar`
 */
export function coreUrl(path: string): string {
  return join(process.env.CORE_SERVICE_INTERNAL_URL ?? 'http://core-service:3012', path);
}
