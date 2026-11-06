import { ConflictException, GoneException } from '@nestjs/common';

/**
 * A POST CREATED TWICE IS ONE POST: the id is the client's, so a resend is recognised by DURABLE
 * STATE (the primary key), never by a time window or a content match.
 *
 * WHY. The app's background publish queue (frontend `posts/publishQueue/`) closes the composer at
 * once and sends the post later, over whatever link the phone has. An answer lost after the row was
 * written - a cut link, a suspended app - is indistinguishable, client side, from a request that
 * never arrived, and the queue sends it again. With a server-generated id that second request made a
 * second post. The client now mints the post's UUID when it QUEUES the post and sends it as `id`;
 * the row that request writes carries it, so a resend finds it.
 *
 * A DELETED POST STAYS DELETED. Every hard delete writes the id to `deleted_post_ids` (migration
 * 134, a trigger), and a create under such an id is a 410: a resend of a post the member withdrew,
 * or one taken down, never brings it back.
 *
 * WHO MAY REPLAY. Only the author the row was written for: the same id from anyone else is a 409.
 * That answer is an existence oracle - it says a post holds that id - which is accepted: the id is a
 * random UUIDv4 (122 bits, `@IsUUID('4')` on the DTO), and a post's id is shown to everyone who can
 * read it anyway. An id is optional: a client that sends none (every build before this one) gets the
 * server-generated id, as before.
 */
export type ClientIdVerdict = 'create' | 'replay';

/**
 * What a create carrying a client id must do, given the row already stored under that id (or none)
 * and whether that id belongs to a post that was deleted.
 *
 * @throws ConflictException when the id belongs to another author's post.
 * @throws GoneException when no post holds the id and a deleted one did.
 */
export function clientIdVerdict(
  existing: { authorId: string } | null,
  deleted: boolean,
  authorId: string
): ClientIdVerdict {
  if (existing) {
    if (existing.authorId === authorId) return 'replay';
    throw new ConflictException('This post id is already taken');
  }
  if (deleted) throw new GoneException('This post was deleted');
  return 'create';
}
