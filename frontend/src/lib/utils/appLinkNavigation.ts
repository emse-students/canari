import { gotoAppPath } from '$lib/navigation/gotoAppPath';
import { isClaimedAppLinkPath } from '$lib/mobile/appSiteAssociation';
import { inAppPathFromHref, inAppPathFromPublicUrl, isPublicAppUrl } from '$lib/utils/publicAppUrl';
import { describeDeepLink } from '$lib/utils/logSanitize';

/**
 * Navigates to an in-app route when `href` is a public Canari URL or a supported relative path.
 * Returns true when navigation was handled.
 *
 * The path is of unknown origin (a link in a message, an App Link), so `gotoAppPath` asks the route
 * table before navigating; it used to hand it to `goto` and load the document when that failed,
 * which under SvelteKit 3 is learning from a rejection what `match` says up front.
 */
export async function navigateInAppFromHref(href: string): Promise<boolean> {
  const path = inAppPathFromHref(href);
  if (!path) return false;

  console.log(
    '[appLink] In-app navigation ->',
    describeDeepLink(new URL(path, 'https://app.invalid').href)
  );
  await gotoAppPath(path).catch((err: unknown) =>
    console.error('[appLink] In-app navigation failed:', err)
  );
  return true;
}

/**
 * Navigates to an in-app route when `url` is a public Canari web link.
 * Returns true when navigation was handled.
 */
export async function navigateInAppFromPublicUrl(url: string): Promise<boolean> {
  return navigateInAppFromHref(url);
}

/**
 * Opens a public Canari URL handed to the app from OUTSIDE - an App Link, or
 * `fr.emse.canari://open?url=` from a page leaving an in-app browser - and says whether it did.
 *
 * Only a path the app CLAIMS opens: the same test the system applied before delivering an App
 * Link, so a URL that arrives by the custom scheme, which anyone can write, cannot reach anything
 * a link could not. A relative or malformed value is refused before its pathname is read.
 */
export function openClaimedAppLink(href: string): boolean {
  if (!isPublicAppUrl(href) || !inAppPathFromPublicUrl(href)) return false;
  if (!isClaimedAppLinkPath(new URL(href.trim()).pathname)) return false;
  void navigateInAppFromPublicUrl(href);
  return true;
}
