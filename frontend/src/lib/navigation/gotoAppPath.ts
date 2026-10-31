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
 * where SvelteKit 2 navigated natively. Every caller below had written
 * `goto(resolve(internalPath(x)))` against the old contract: a Back button that did nothing, a
 * sign-in that ended on "the exchange failed" after it had succeeded, a saved form whose page
 * stayed on screen with its button live again. Learning that from the rejection would be handing
 * the router an operation certain to fail in order to classify the failure, so the fact is read
 * before the decision (`match`, the same table `goto` consults).
 *
 * WHAT A PATH WITH NO ROUTE DOES. It is loaded as a document - Kit's own instruction for such a
 * URL, and what SvelteKit 2 did. What answers it depends on the platform:
 * - On the WEB (adapter-node), the server: the current deployment may have the page (a link to a
 *   page added since this tab loaded), and otherwise answers with the app's 404 page.
 * - On the PHONE APPS (adapter-static, `index.html` as the fallback for every path), the same
 *   EMBEDDED build: the load is a cold restart of the app on the build that just reported it has
 *   no such route, and it ends on its own 404 page, `+error.svelte`, with its way home. The cost is
 *   a restart, and it is paid knowingly: it is the one outcome that leaves the reader on a page
 *   that says where they are, instead of on the page they tried to leave.
 * It is logged at ERROR, by its SHAPE (`describeDeepLink`, never the path - it can carry ids), with
 * the build, because something produced a link this build does not have and that is worth finding.
 *
 * WHAT IS LOADED. A target is validated against the page's origin before a full-page load, and the
 * load is given the CHECKED value, never the string it was built from. A target on another origin
 * is refused and logged; nothing is loaded.
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
  const url = new URL(target, window.location.href);
  if (url.origin !== window.location.origin) {
    console.error(
      `[nav] gotoAppPath refused a target (length ${path.length}) that resolves to another origin - nothing loaded`
    );
    return;
  }
  console.error(
    `[nav] ${describeDeepLink(url.href)} matches no route of version ${getClientAppVersion()} - loaded as a document`
  );
  if (opts.replace) window.location.replace(url.href);
  else window.location.assign(url.href);
}
