import { MOBILE_APP_PROTOCOL } from './appSiteAssociation';
import { FOLLOW_REQUESTS_ROUTE, REPUBLICATION_REQUESTS_ROUTE } from '$lib/posts/notificationTarget';
import { formResponsesRoute } from '$lib/forms/responsesLink';
import { BOOKINGS_HREF } from '$lib/bookings/routes';

/**
 * The query parameter naming the comment a post link opens at - written by the server into a
 * comment push (`socialDeepLink` in social-service) and read by the post page.
 */
export const POST_COMMENT_PARAM = 'comment';

/**
 * The app route behind a `fr.emse.canari://<host>[/<id>]` link that opens a PAGE - the table a
 * notification tap lands through, kept apart from the hook that listens so it can be tested.
 *
 * The hosts are the ones the server writes into a social push (`socialDeepLink` in social-service)
 * and the ones Android and iOS build natively: `post/<id>`, `form/<id>`, `posts`, `calendar`,
 * `admin-agenda`, `live/<id>`, `republication-requests` (D38b), `follow-requests` (WP-F4),
 * `notifications` (WP-L8b), `bookings` (WP-N) and
 * `form-responses/<id>` (the organiser alert for a payment over capacity). `posts` is what a payload
 * naming nothing falls back to on the server, and it has no id; the two agenda hosts and
 * `republication-requests` mirror `notificationHref` (the in-app bell).
 *
 * Returns null for a host this table does not own (chat, callback, payment and open have their own
 * handling) or for a host that needs an id and has none, so the caller can log instead of guessing.
 */
export function appRouteForDeepLink(u: URL): string | null {
  if (u.protocol !== MOBILE_APP_PROTOCOL) return null;
  const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
  switch (u.host) {
    case 'post': {
      if (!id) return null;
      // A comment, reply or mention push names the comment: the post page scrolls to it.
      const comment = u.searchParams.get(POST_COMMENT_PARAM);
      const route = `/posts/${encodeURIComponent(id)}`;
      return comment ? `${route}?${POST_COMMENT_PARAM}=${encodeURIComponent(comment)}` : route;
    }
    case 'form':
      return id ? `/forms/${encodeURIComponent(id)}` : null;
    // The organiser alert (a payment landed on a full form): that form's responses on the list.
    case 'form-responses':
      return id ? formResponsesRoute(id) : null;
    case 'posts':
      return '/posts';
    case 'calendar':
      return '/calendar';
    case 'admin-agenda':
      return '/admin/agenda';
    // "X est en live" (WP-L7): the FEED, where the LIVE card is to be (L5). The live's own viewer
    // page is WP-L5, still owed, so the id is not read yet; the host is owned here so the tap lands
    // on the feed instead of the unknown-host branch of the hook.
    case 'live':
      return '/posts';
    // D38b: a request to let an association carry a personal post - the author's inbox.
    case 'republication-requests':
      return REPUBLICATION_REQUESTS_ROUTE;
    // WP-F4: a person asks to follow the reader - the inbox where it is answered.
    case 'follow-requests':
      return FOLLOW_REQUESTS_ROUTE;
    // WP-L8b: a notice whose subject has no page - a live moderators cut (deleted at its end), a
    // suspension or a withdrawal of the right to broadcast. Its row on the list says it.
    case 'notifications':
      return '/notifications';
    // WP-N: a booking cancelled, left, made for the reader, or about to start - Reservations,
    // where the reader's bookings are listed.
    case 'bookings':
      return BOOKINGS_HREF;
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
