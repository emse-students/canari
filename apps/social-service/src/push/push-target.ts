/**
 * The `target` naming a person's follow-request inbox (WP-F4), and the deep-link host for it: the tap
 * of a `follow_request` push. A build older than the inbox does not own the host and lands on the
 * notifications list (the hook's unknown-host branch), where the request's row is.
 */
export const FOLLOW_REQUESTS_TARGET = 'follow-requests';

/** The `target` naming a person's republication requests page (D38b), and the deep-link host for it. */
export const REPUBLICATION_REQUESTS_TARGET = 'republication-requests';

/**
 * The `target` naming the reader's own notifications list, and the deep-link host for it: the tap of
 * a notice whose subject has no page - a live moderators cut (deleted when it ended), a suspension or
 * a withdrawal of the right to broadcast (WP-L8b). The row on that list is what says it.
 */
export const NOTIFICATIONS_TARGET = 'notifications';

/**
 * The `target` naming ONE FORM'S RESPONSES, and the deep-link host for it: the tap of the organiser
 * alert (a payment landed on a full form, `form_paid_over_capacity`). The responses are an accordion
 * on the forms list, not a page, so the app opens `/forms?responses=<formId>` - a form's own
 * `form/<id>` link opens the page that ANSWERS it, which is not where a refund is decided.
 */
export const FORM_RESPONSES_TARGET = 'form-responses';

/**
 * WHERE A SOCIAL PUSH GOES WHEN IT IS TAPPED, as a deep link the SERVER writes.
 *
 * A tap is handled natively and the two platforms used to disagree about what it needed. Android
 * built the link from `postId` / `formId` itself; iOS opens `userInfo["deepLink"]` and nothing else,
 * and the notification service extension never wrote one for a post or a form - so on an iPhone the
 * tap launched the app and left it where it was. One field the server fills is one implementation:
 * both platforms already prefer an explicit `deepLink` over anything they derive.
 *
 * The routes mirror `notificationHref` in the frontend (the in-app bell): a form reminder opens its
 * form, an event proposal opens the validation queue, every other agenda notice opens the calendar,
 * and a post notice opens the post. The hosts are resolved by `appRouteForDeepLink` in the frontend.
 *
 * @param data - The flat push data the caller built (`postId`, `commentId`, `formId`, `action`,
 *   `associationId`, `queueAssociationId`, `liveId`).
 */
export function socialDeepLink(data: Record<string, string>): string {
  const formId = data.formId;
  // Before the plain form link: the organiser alert carries the form too, and must open its
  // RESPONSES rather than the page that answers it. A typed target, from a closed set.
  if (formId && data.target === FORM_RESPONSES_TARGET) {
    return `fr.emse.canari://${FORM_RESPONSES_TARGET}/${encodeURIComponent(formId)}`;
  }
  if (formId) return `fr.emse.canari://form/${encodeURIComponent(formId)}`;
  // The agenda's six notices carry `action` and the ASSOCIATION, never a post: a pending event has no
  // page of its own, so a proposal goes to the queue where it is acted on and the rest to the agenda.
  if (data.action) {
    return data.action === 'proposed'
      ? 'fr.emse.canari://admin-agenda'
      : 'fr.emse.canari://calendar';
  }
  // A republication or co-organisation PROPOSAL: its `postId` is the receiving association, and the
  // page that matters is that association's proposal queue, which the app reaches by slug (see
  // `proposalQueueAssociationId` in the frontend). Without this the push landed on the feed.
  if (data.queueAssociationId) {
    return `fr.emse.canari://proposals/${encodeURIComponent(data.queueAssociationId)}`;
  }
  // A live started (WP-L7): the live itself. The app's route for it is WP-L5's viewer, still owed -
  // until then `appRouteForDeepLink` sends this host to the feed (`/posts`), where the LIVE card is
  // to be. A build older than that route does not route it: it opens the app, and at most lands on
  // the notifications list (the hook's unknown-host branch).
  if (data.liveId) return `fr.emse.canari://live/${encodeURIComponent(data.liveId)}`;
  // A request to the AUTHOR to republish their personal post (D38b): their own requests page, where
  // the answer is given. A TYPED target, from a closed set - never a path the payload names.
  if (data.target === REPUBLICATION_REQUESTS_TARGET) {
    return `fr.emse.canari://${REPUBLICATION_REQUESTS_TARGET}`;
  }
  // A follow request (WP-F4): the inbox where it is answered. Before `postId`, which a follow notice
  // carries as the ASKER's id - a `post/<id>` link would open a post that does not exist.
  if (data.target === FOLLOW_REQUESTS_TARGET) {
    return `fr.emse.canari://${FOLLOW_REQUESTS_TARGET}`;
  }
  // A notice with no page of its own (a cut live, a suspension, a withdrawal): the notifications
  // list, where its row says it. Before `postId`, which such a notice carries as the live's id or
  // the member's - a `post/<id>` link would open a post that does not exist.
  if (data.target === NOTIFICATIONS_TARGET) {
    return `fr.emse.canari://${NOTIFICATIONS_TARGET}`;
  }
  const postId = data.postId;
  if (postId) {
    const post = `fr.emse.canari://post/${encodeURIComponent(postId)}`;
    // A comment, a reply or a mention in a comment opens the post AT that comment: the app scrolls
    // to it (`?comment=`, read by `appRouteForDeepLink` and the post page). A query rather than a
    // path segment, so a build that predates it still opens the post.
    return data.commentId ? `${post}?comment=${encodeURIComponent(data.commentId)}` : post;
  }
  return 'fr.emse.canari://posts';
}
