import { BadRequestException } from '@nestjs/common';

/**
 * THE CURSOR OF A FOLLOW LIST (the inbox, the followers, the sent requests): where the next page
 * starts, as the DURABLE KEYS of the last row served - its sort instant and its row id - never an
 * offset. An offset counts rows, and the lists change under the reader as they use them (an
 * acceptance, a removal, a withdrawal takes a row out, a new request puts one in), so page 2 of an
 * offset skips or repeats a person; the keys of a row are still the keys of that row after its
 * neighbours moved. Every follow list is ordered `(instant DESC, id DESC)` and the next page is
 * `(instant, id) < (cursor)`: a strict total order, so no row is served twice and none is skipped.
 *
 * THE INSTANT TRAVELS AS POSTGRESQL'S OWN TEXT of the column (`::text`), never through a JS `Date`:
 * a `Date` keeps milliseconds and the columns hold microseconds, so a cursor rebuilt from one would
 * sit BETWEEN two rows of the same millisecond and serve one of them twice. The text casts back to
 * exactly the value it came from.
 *
 * OPAQUE to the client - base64url of `[instant, id]` - so it carries nothing it should read, and a
 * malformed one is a 400 `FOLLOW_CURSOR_INVALID` decided HERE, never a SQL cast error at the
 * database.
 */

/** The 400 code of a cursor that is not one this server wrote. */
export const FOLLOW_CURSOR_INVALID = 'FOLLOW_CURSOR_INVALID';

/** The decoded keys a page starts after. */
export interface FollowCursor {
  /** The sort column's text, as PostgreSQL printed it (`timestamp` or `timestamptz`). */
  at: string;
  /** The tie-breaking key of the last row served: a `user_follows.id`, or a person's id. */
  id: string;
}

/** A `timestamp` or `timestamptz` as PostgreSQL prints it under the ISO `DateStyle`. */
const PG_INSTANT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2}){0,2})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Far beyond any cursor this file writes: a longer one is refused before it is decoded. */
const CURSOR_MAX_LENGTH = 200;

/**
 * What a list's tie-breaking key looks like, and so how long its cursor may be. The follow lists
 * break ties on the row's uuid ({@link FOLLOW_ROW_KEY}); a list with one row per PERSON - the
 * reposters of a post (WP-F6), keyed `(postId, reposterId)` - breaks them on the person's id
 * ({@link PERSON_KEY}), a `varchar(255)` with no fixed shape. Either way the key reaches SQL as a
 * bound parameter, never spliced; the check only keeps a cursor this server did not write a 400.
 */
export interface CursorKeyShape {
  /** Whether `id` is a key this list could hold. */
  accepts: (id: string) => boolean;
  /** The longest cursor that may name one of its rows - every key it accepts fits. */
  maxLength: number;
}

/** A follow list: the key is the `user_follows` row's uuid. */
export const FOLLOW_ROW_KEY: CursorKeyShape = {
  accepts: (id) => UUID_RE.test(id),
  maxLength: CURSOR_MAX_LENGTH,
};

/** The longest `users.id` there is, in characters (code points): the column is a `varchar(255)`. */
const PERSON_ID_MAX = 255;

/**
 * The longest cursor a person-keyed row can have, from the worst case rather than a guess: in the
 * JSON each character of the id is at most 4 UTF-8 bytes (a `"` or a `\` escapes to 2, an astral
 * character is 4), the instant and the punctuation at most 64 more, and base64 writes 4 characters
 * per 3 bytes.
 */
const PERSON_CURSOR_MAX = Math.ceil((PERSON_ID_MAX * 4 + 64) / 3) * 4;

/**
 * A list of people keyed by `users.id` (`varchar(255)`). Any 1..255 characters with no control
 * character - wider than the rule ids are minted under today (core-service's `users/user-id.ts`)
 * on purpose: an id minted before that rule is still a person, and a cursor or a removal naming
 * them must keep working.
 */
export const PERSON_KEY: CursorKeyShape = {
  accepts: (id) => {
    const chars = [...id];
    return (
      chars.length >= 1 &&
      chars.length <= PERSON_ID_MAX &&
      chars.every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code > 0x1f && code !== 0x7f;
      })
    );
  },
  maxLength: PERSON_CURSOR_MAX,
};

/** The cursor naming the row whose sort text is `at` and id is `id`. */
export function encodeFollowCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back. `undefined` or empty is "the first page" (`null`); anything else this file
 * did not write is a 400 - a repeated `?after=` arrives as an array, and is refused like any other.
 */
export function decodeFollowCursor(
  raw: unknown,
  key: CursorKeyShape = FOLLOW_ROW_KEY
): FollowCursor | null {
  if (raw === undefined || raw === '') return null;
  const refuse = () =>
    new BadRequestException({ code: FOLLOW_CURSOR_INVALID, message: 'Invalid list cursor' });
  if (typeof raw !== 'string' || raw.length > key.maxLength) throw refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw refuse();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !PG_INSTANT_RE.test(parsed[0]) ||
    !key.accepts(parsed[1])
  ) {
    throw refuse();
  }
  return { at: parsed[0], id: parsed[1] };
}
