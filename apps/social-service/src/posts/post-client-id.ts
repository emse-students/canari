import { ConflictException } from '@nestjs/common';

/**
 * A POST CREATED TWICE IS ONE POST: the id is the client's, so a resend is recognised by DURABLE
 * STATE (the primary key), never by a time window or a content match.
 *
 * WHY. The app's background publish queue (frontend `posts/postSendQueue`) closes the composer at
 * once and sends the post later, over whatever link the phone has. An answer lost after the row was
 * written - a cut link, a suspended app - is indistinguishable, client side, from a request that
 * never arrived, and the queue sends it again. With a server-generated id that second request made a
 * second post. The client now mints the post's UUID when it QUEUES the post and sends it as `id`;
 * the row that request writes carries it, so a resend finds it.
 *
 * WHO MAY REPLAY. Only the author the row was written for: the same id from anyone else is a 409,
 * which tells them nothing they could not read (a post id is shown in every feed) and changes
 * nothing. An id is optional: a client that sends none (every build before this one) gets the
 * server-generated id, as before.
 */
export type ClientIdVerdict = 'create' | 'replay';

/**
 * What a create carrying a client id must do, given the row already stored under that id (or none).
 *
 * @throws ConflictException when the id belongs to another author's post.
 */
export function clientIdVerdict(
  existing: { authorId: string } | null,
  authorId: string
): ClientIdVerdict {
  if (!existing) return 'create';
  if (existing.authorId === authorId) return 'replay';
  throw new ConflictException('This post id is already taken');
}
