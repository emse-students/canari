import { goto } from '$app/navigation';
import { match, resolve } from '$app/paths';
import { getClientAppVersion } from '$lib/utils/appVersion';
import { internalPath } from '$lib/utils/internalPath';
import { describeDeepLink } from '$lib/utils/logSanitize';
import { Log } from '$lib/utils/Log';

/**
 * Navigates to an app path OF UNKNOWN ORIGIN - a `returnTo` or `redirect` query parameter, a link
 * typed into a message - asking the route table FIRST whether this build has a page there.
 *
 * WHY. SvelteKit 3's `goto` REJECTS a URL that matches no route (`navigation_route_missing`),
 * where SvelteKit 2 navigated natively and let the server answer. Every caller below had written
 * `goto(resolve(internalPath(x)))` against the old contract: a Back button that did nothing, a
 * sign-in that ended on "the exchange failed" after it had succeeded, a saved form whose page
 * stayed on screen with its button live again. Learning that from the rejection would be handing
 * the router an operation certain to fail in order to classify the failure, so the fact is read
 * before the decision (`match`, the same table `goto` consults).
 *
 * WHAT A PATH WITH NO ROUTE DOES. It is loaded as a document - Kit's own instruction for such a
 * URL, and exactly what SvelteKit 2 did - because the server is the one party that can answer it:
 * a newer build may have the page (a link to a page added since this tab or this app was built),
 * and otherwise the answer is the app's 404 page, `+error.svelte`, with its way home. It is logged
 * at ERROR, by its SHAPE (`describeDeepLink`, never the path - it can carry ids), with the build,
 * because something produced a link this build does not have and that is worth finding.
 *
 * A path whose destination is built by code is typed `AppPath` and goes through `goto` directly:
 * the compiler, not this function, is what vouches for it.
 */
export async function gotoAppPath(path: string, opts: { replace?: boolean } = {}): Promise<void> {
  const target = resolve(internalPath(path));
  const route = await match(target);
  if (route) {
    Log.d('nav', `gotoAppPath -> ${route.id}`);
    await goto(target, opts);
    return;
  }
  console.error(
    `[nav] ${describeDeepLink(new URL(target, window.location.origin).href)} matches no route of version ${getClientAppVersion()} - loaded as a document for the server to answer`
  );
  if (opts.replace) window.location.replace(target);
  else window.location.assign(target);
}
