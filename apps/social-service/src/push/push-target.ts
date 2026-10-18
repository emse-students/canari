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
 *   `associationId`, `queueAssociationId`).
 */
export function socialDeepLink(data: Record<string, string>): string {
  const formId = data.formId;
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
