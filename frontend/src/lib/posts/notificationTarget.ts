import type { PostNotification } from './api';

/**
 * WHERE A NOTIFICATION GOES WHEN IT IS OPENED - the one answer, for both surfaces.
 *
 * The bell dropdown and `/notifications` render the same rows and, until this existed, each decided
 * the destination for itself with its own copy of the same ternary. That is the divergence that
 * comes free with a second copy: the row's own body text had already been through it once, reading
 * `@Marie` on the page and `@[a3f2...]` in the dropdown, and a destination is worse - one surface
 * silently sends a reader somewhere the other does not.
 *
 * WHAT `postId` HOLDS DEPENDS ON THE TYPE, which is why this is a switch and not a template. For a
 * post notification it is a post; for a form reminder it is a form; for the agenda's five it is the
 * ASSOCIATION the event belongs to, because a pending event has no page of its own until it is
 * validated. That is also why an event notification lands on a list rather than on the event: the
 * thing the reader has to do is act on it, and the queue is where acting happens.
 */
export function notificationHref(notif: Pick<PostNotification, 'type' | 'postId'>): string {
  switch (notif.type) {
    case 'form_reminder':
      return `/forms/${notif.postId}`;
    // A calendar manager was told an event is waiting: send them where they can validate it, not to
    // the month view where a pending event is a grey square among thirty.
    case 'event_proposed':
      return '/admin/agenda';
    // The proposer was told what happened to theirs. The answer is already applied, so the agenda
    // is the page that shows it - or shows it gone, for a refusal or a deletion.
    case 'event_validated':
    case 'event_rejected':
    case 'event_updated':
    case 'event_deleted':
      return '/calendar';
    default:
      return `/posts/${notif.postId}`;
  }
}
