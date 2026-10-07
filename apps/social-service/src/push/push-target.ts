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
 * @param data - The flat push data the caller built (`postId`, `formId`, `action`, `associationId`).
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
  const postId = data.postId;
  if (postId) return `fr.emse.canari://post/${encodeURIComponent(postId)}`;
  return 'fr.emse.canari://posts';
}
