import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { decryptVaultNote } from '$lib/associations/vaultCrypto';
import type { OutboxSettlement } from '$lib/utils/chat/outbox';
import { m } from '$lib/paraglide/messages';

/**
 * THE PERSONAL NOTEPAD MOVES INTO "MES NOTES" (owner, 2026-11-22, item 12; `1.8.2`, decided
 * 2026-11-25). It sat in `users.notesCiphertext` under a key the server held, which charter principle
 * 1 refuses; principle 2 says nothing of it may be lost on the way. So a device that still finds one
 * posts it as a message of the account's conversation with itself, and only once that message is
 * SENT asks the server to delete the notepad - naming the digest of what it read, so the server
 * never deletes a copy an older build saved since (`apps/core-service/src/users/notepad.ts`).
 *
 * IDEMPOTENCE IS DURABLE STATE, NEVER A CLOCK. Every step can be cut by a kill and replayed:
 * - the message id is DERIVED from the account and the notepad's digest ({@link notepadMessageId}),
 *   so a replay - on this device or on another device of the account moving the same notepad - names
 *   the SAME message: this device asks its own store first (`heldAs`) and does not queue it twice,
 *   and a copy arriving from another device under that id is "already held" on every receiver;
 * - the server's notepad is the "still owed" bit: while it is held the move is owed, once it is gone
 *   (`410 NOTEPAD_MOVED`) nothing is, and it cannot come back - no notepad is ever CREATED again;
 * - the local mark only spares the read once the server has answered `NOTEPAD_MOVED` or the move
 *   succeeded; it never decides anything the server has not said.
 *
 * Full argument: `docs/wiki/frontend/modules/chat.md`, "The notepad moves in".
 */

/** What the server holds of this account's notepad. */
export type NotepadRead =
  | { kind: 'moved' }
  | {
      kind: 'held';
      /** The decrypted notepad (markdown), or its legacy plaintext. */
      text: string;
      /** SHA-256 (hex) of the stored string exactly as served - what the move names. */
      digest: string;
    };

/** The server's answer to a move: deleted (or gone already), or held under another digest now. */
export type NotepadMoveAnswer = 'moved' | 'changed';

/** How one run ended, for its log line and its test. */
export type NotepadMigrationOutcome =
  /** The local mark says the server already answered: nothing asked. */
  | 'done-before'
  /** The server holds no notepad (moved by another device, or never written). */
  | 'nothing-held'
  /** Posted, sent, and deleted on the server. */
  | 'moved'
  /** "Mes notes" is not on this device yet (another device's copy is arriving): next run. */
  | 'waiting-for-notes'
  /** Queued, not sent yet (or parked failed for the member's retry): the notepad is kept. */
  | 'posting'
  /** The server holds another notepad than the one read: the next run reads it again. */
  | 'changed';

/** The facts and acts one run needs, each from where it is known. */
export interface NotepadMigrationDeps {
  userId: string;
  readNotepad(): Promise<NotepadRead>;
  /** The key of a self conversation this device can post into, or why there is none yet. */
  ensureSelfConversation(): Promise<{ key: string } | { waiting: string }>;
  /** What this device's store holds of message `messageId` (`useMessaging.heldAs`); null = nothing. */
  heldAs(messageId: string): Promise<OutboxSettlement | null>;
  /** Queues `text` under `messageId` and reports how the queue settled it (`useMessaging.sendTextTo`). */
  send(
    text: string,
    conversationKey: string,
    messageId: string
  ): Promise<OutboxSettlement | 'not-queued' | 'gone'>;
  confirmMoved(digest: string): Promise<NotepadMoveAnswer>;
  doneMark: { read(): boolean; write(): void };
  log(line: string): void;
}

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export async function sha256HexOfText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The id of the message carrying notepad `digest` of account `userId`: the same on every device and
 * every replay, shaped as a UUID (version 8, "custom", RFC 9562) so it travels where a minted id does.
 */
export async function notepadMessageId(userId: string, digest: string): Promise<string> {
  const hex = await sha256HexOfText(`canari-notepad-move:${userId}:${digest}`);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The message posted: a heading saying where it came from, then the notepad as it was. */
export function notepadMessageText(notepad: string): string {
  return `${m.notepad_moved_heading()}\n\n${notepad}`;
}

/**
 * One run of the move. Never throws: a failure is logged and the notepad stays on the server, owed,
 * for the next run (`readNotepad` and `confirmMoved` throw only for a missing answer or an
 * unexpected status, and both leave the server's notepad as it was).
 */
export async function runNotepadMigration(
  deps: NotepadMigrationDeps
): Promise<NotepadMigrationOutcome | 'unanswered'> {
  if (deps.doneMark.read()) return 'done-before';
  try {
    return await migrate(deps);
  } catch (e) {
    deps.log(
      `[NOTEPAD] move not finished, the notepad stays on the server for the next run: ${String(e)}`
    );
    return 'unanswered';
  }
}

async function migrate(deps: NotepadMigrationDeps): Promise<NotepadMigrationOutcome> {
  const read = await deps.readNotepad();
  if (read.kind === 'moved') {
    deps.log('[NOTEPAD] the server holds no notepad - nothing to move');
    deps.doneMark.write();
    return 'nothing-held';
  }
  const notepad = read.text.trim();
  if (notepad) {
    const self = await deps.ensureSelfConversation();
    if ('waiting' in self) {
      deps.log(
        `[NOTEPAD] a notepad is held, "Mes notes" is not on this device yet (${self.waiting}) - kept`
      );
      return 'waiting-for-notes';
    }
    const messageId = await notepadMessageId(deps.userId, read.digest);
    const held = await deps.heldAs(messageId);
    const settled = held ?? (await deps.send(notepadMessageText(notepad), self.key, messageId));
    deps.log(
      `[NOTEPAD] ${messageId.slice(0, 8)}... ${held === null ? 'queued into "Mes notes"' : 'already held here'} - ${settled}`
    );
    if (settled !== 'sent') {
      // Deleted only once the message has LEFT: a queued copy is on this device alone.
      return 'posting';
    }
  } else {
    deps.log('[NOTEPAD] the notepad held is blank - deleted without a message');
  }
  const answer = await deps.confirmMoved(read.digest);
  if (answer === 'changed') {
    deps.log(
      '[NOTEPAD] the server holds another notepad than the one moved (saved since) - read again next run'
    );
    return 'changed';
  }
  deps.log('[NOTEPAD] notepad moved into "Mes notes" and deleted from the server');
  deps.doneMark.write();
  return 'moved';
}

/** The `code` of a refusal body, or null when the body is not one. */
async function codeOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

/**
 * Reads the notepad through the routes that retire with it: `410 NOTEPAD_MOVED` is the ANSWER "none
 * held"; any other non-2xx throws (nothing is decided on it). A ciphertext is decrypted under the
 * account's notepad key; a legacy plaintext is taken as it is.
 */
export async function readNotepadForMove(): Promise<NotepadRead> {
  const res = await apiFetch(`${coreUrl()}/api/users/me/notes`);
  if (res.status === 410 && (await codeOf(res)) === 'NOTEPAD_MOVED') return { kind: 'moved' };
  if (!res.ok) throw new Error(`notepad read answered ${res.status}`);
  const data = (await res.json()) as { ciphertext?: string; legacyNotes?: string };
  const stored = data.ciphertext || data.legacyNotes || '';
  const digest = await sha256HexOfText(stored);
  if (!data.ciphertext) return { kind: 'held', text: stored, digest };
  const keyRes = await apiFetch(`${coreUrl()}/api/users/me/notes-key`);
  if (!keyRes.ok) throw new Error(`notepad key answered ${keyRes.status}`);
  const { key } = (await keyRes.json()) as { key?: string };
  if (!key) throw new Error('notepad key answered empty');
  return { kind: 'held', text: await decryptVaultNote(key, data.ciphertext), digest };
}

/** Asks the server to delete the notepad of `digest` (`POST /users/me/notes/moved`). */
export async function confirmNotepadMoved(digest: string): Promise<NotepadMoveAnswer> {
  const res = await apiFetch(`${coreUrl()}/api/users/me/notes/moved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ digest }),
  });
  if (res.ok) return 'moved';
  const code = await codeOf(res);
  if (res.status === 410 && code === 'NOTEPAD_MOVED') return 'moved';
  if (res.status === 409 && code === 'NOTEPAD_CHANGED') return 'changed';
  throw new Error(`notepad move answered ${res.status}${code ? ` ${code}` : ''}`);
}

/** The per-account local mark: the server has said there is nothing (left) to move. */
export function notepadDoneMark(userId: string): NotepadMigrationDeps['doneMark'] {
  const key = `canari.notepad-moved.${userId}`;
  return {
    read: () => {
      try {
        return localStorage.getItem(key) === '1';
      } catch (e) {
        console.debug(`[NOTEPAD] mark unreadable (${String(e)}) - the server is asked`);
        return false;
      }
    },
    write: () => {
      try {
        localStorage.setItem(key, '1');
      } catch (e) {
        console.debug(
          `[NOTEPAD] mark not written (${String(e)}) - the server answers again next run`
        );
      }
    },
  };
}
