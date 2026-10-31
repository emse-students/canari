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
  /** The `user_follows.id` of the last row served. */
  id: string;
}

/** A `timestamp` or `timestamptz` as PostgreSQL prints it under the ISO `DateStyle`. */
const PG_INSTANT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2}){0,2})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Far beyond any cursor this file writes: a longer one is refused before it is decoded. */
const CURSOR_MAX_LENGTH = 200;

/** The cursor naming the row whose sort text is `at` and id is `id`. */
export function encodeFollowCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back. `undefined` or empty is "the first page" (`null`); anything else this file
 * did not write is a 400.
 */
export function decodeFollowCursor(raw: string | undefined): FollowCursor | null {
  if (raw === undefined || raw === '') return null;
  const refuse = () =>
    new BadRequestException({ code: FOLLOW_CURSOR_INVALID, message: 'Invalid list cursor' });
  if (raw.length > CURSOR_MAX_LENGTH) throw refuse();
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
    !UUID_RE.test(parsed[1])
  ) {
    throw refuse();
  }
  return { at: parsed[0], id: parsed[1] };
}
