import { ConflictException, GoneException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { User } from './entities/user.entity';
import { RefusalCode, refusalBody } from '../common/refusal-codes';

/**
 * THE PERSONAL NOTEPAD IS RETIRED INTO "MES NOTES" (owner, 2026-11-22, item 12; moved to `1.8.2`
 * on 2026-11-25). It sat in `users.notesCiphertext` under a key this server held (`users.notesKey`),
 * which charter principle 1 refuses: a client that still finds one posts it as a message of its
 * conversation with itself, then asks this service to delete it - by naming the digest of what it
 * read, so a copy an older build saved since is never deleted unread
 * (`docs/wiki/frontend/modules/chat.md`, "The notepad moves in").
 *
 * WHAT "HELD" MEANS, in one place: the ciphertext when there is one, else the plaintext written
 * before the notepad was encrypted - the same rule `getNotes` has always served by. An empty string
 * is no notepad. The SQL twin of this rule is {@link HELD_NOTEPAD_SQL}; the two must agree.
 */
export function heldNotepad(user: Pick<User, 'notesCiphertext' | 'notes'>): string {
  return user.notesCiphertext || user.notes || '';
}

/** {@link heldNotepad} as a SQL expression over the `users` row: NULL when nothing is held. */
export const HELD_NOTEPAD_SQL = `COALESCE(NULLIF("notesCiphertext", ''), NULLIF(notes, ''))`;

/**
 * The digest a mover names: SHA-256 (hex) of the held string exactly as `GET /users/me/notes`
 * served it. The client computes the same over the same bytes (`notepadMigration.ts`).
 */
export function notepadDigest(held: string): string {
  return createHash('sha256').update(held, 'utf8').digest('hex');
}

/**
 * The answer of every notepad route once the caller holds none: 410 `NOTEPAD_MOVED`. A status, not
 * a transport failure - the client reads it as "nothing left to move" and stops asking.
 */
export class NotepadMovedException extends GoneException {
  constructor() {
    super(
      refusalBody(
        RefusalCode.NOTEPAD_MOVED,
        'the personal notepad has moved into "Mes notes" - update the app'
      )
    );
  }
}

/** 409 `NOTEPAD_CHANGED`: the digest named is not the notepad held now. Nothing was deleted. */
export class NotepadChangedException extends ConflictException {
  constructor() {
    super(
      refusalBody(
        RefusalCode.NOTEPAD_CHANGED,
        'the notepad changed since it was read - read it again before moving it'
      )
    );
  }
}
