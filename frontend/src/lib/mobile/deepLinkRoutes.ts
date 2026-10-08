import { MOBILE_APP_PROTOCOL } from './appSiteAssociation';

/**
 * The app route behind a `fr.emse.canari://<host>[/<id>]` link that opens a PAGE - the table a
 * notification tap lands through, kept apart from the hook that listens so it can be tested.
 *
 * The hosts are the ones the server writes into a social push (`socialDeepLink` in social-service)
 * and the ones Android and iOS build natively: `post/<id>`, `form/<id>`, `posts`, `calendar` and
 * `admin-agenda`. `posts` is what a payload naming nothing falls back to on the server, and it has
 * no id; the two agenda hosts mirror `notificationHref` (the in-app bell).
 *
 * Returns null for a host this table does not own (chat, callback, stripe and open have their own
 * handling) or for a host that needs an id and has none, so the caller can log instead of guessing.
 */
export function appRouteForDeepLink(u: URL): string | null {
  if (u.protocol !== MOBILE_APP_PROTOCOL) return null;
  const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
  switch (u.host) {
    case 'post':
      return id ? `/posts/${encodeURIComponent(id)}` : null;
    case 'form':
      return id ? `/forms/${encodeURIComponent(id)}` : null;
    case 'posts':
      return '/posts';
    case 'calendar':
      return '/calendar';
    case 'admin-agenda':
      return '/admin/agenda';
    default:
      return null;
  }
}

/**
 * The association id behind a `fr.emse.canari://proposals/<associationId>` link - the tap of a
 * republication or co-organisation PROPOSAL push - or null for any other URL.
 *
 * It is not in {@link appRouteForDeepLink} because its page is reached by SLUG: the caller resolves
 * the id with `getAssociation` (`resolveNotificationHref`, the same path the notifications page
 * takes) before it can name a route.
 */
export function proposalQueueAssociationId(u: URL): string | null {
  if (u.protocol !== MOBILE_APP_PROTOCOL || u.host !== 'proposals') return null;
  const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return id || null;
}
