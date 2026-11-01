/**
 * THE DURABLE "TO RELEASE" MARK OF A RESUMABLE UPLOAD SESSION (the P2 owed before
 * `CHAT_REEL_WRITER_ENABLED`, reels-in-chat section 14).
 *
 * A withdrawn chat reel gives its media-service upload session back with a `DELETE`. Made offline -
 * the weak link the reel was stuck on - that `DELETE` gets no answer, and the session used to be left
 * to the server's 24 h sweep: one of the owner's 4 open sessions, up to 256 MiB staged and a share of
 * the daily `chat-reel` budget, so four such cancels in a day answered the member 429.
 *
 * So the release is OWED IN DURABLE STATE, not in a promise: the session id is written here BEFORE the
 * `DELETE` goes, and removed only once the server ANSWERED it ({@link ReleaseAnswer} `answered`). A
 * mark left behind is released again at the next start and on every reconnect, under the owner's own
 * token, until an answer comes. Idempotent by the server: a session already gone answers 404, which
 * is an answer.
 *
 * WHERE IT LIVES, AND WHY THERE: one device-wide `localStorage` key, NOT the per-account outbox
 * database - the mark must outlive what the outbox loses (a row deleted by the withdrawal itself).
 * It holds session ids keyed by owner id and NO key: a session id names staged ciphertext its owner
 * can already address, and the server checks the owner on every route. An account deletion drops its
 * owner's marks with the rest of its local data ({@link dropUploadReleaseMarksOf}); the server ends
 * that owner's sessions itself in the erasure fan-out, since no device of a deleted account holds a
 * token to release them with.
 */
import { connectivity } from '$lib/stores/connectivity.svelte';

/** The one device-wide key. Holds `{ [ownerId]: uploadId[] }`. */
export const UPLOAD_RELEASE_MARKS_KEY = 'canari_upload_release_marks';

/** The slice of `Storage` the marks need (a test passes a Map-backed one). */
export type MarkStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * What one `DELETE` came back with. `answered`: the server said something final about the session
 * (released, already gone, completed, not this owner's) - the mark goes. `unanswered`: transport
 * failure, an edge page, a 5xx, a refused token - the mark stays for the next pass.
 */
export type ReleaseAnswer = 'answered' | 'unanswered';

/** Gives a session back; never rejects (a releaser that does is treated as `unanswered`, said). */
export type SessionReleaser = (uploadId: string, why: string) => Promise<ReleaseAnswer>;

function defaultStore(): MarkStore | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function readMarks(store: MarkStore, log: (line: string) => void): Record<string, string[]> {
  const raw = store.getItem(UPLOAD_RELEASE_MARKS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string[]> = {};
      for (const [owner, ids] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(ids))
          out[owner] = ids.filter((id): id is string => typeof id === 'string');
      }
      return out;
    }
  } catch {
    // Falls through to the accusation below.
  }
  // Nothing in the app writes another shape: a damaged value loses the marks it held, which the
  // server's 24 h sweep still covers. Said at ERROR, and dropped so it is not met at every start.
  log(
    `[UPLOAD-RELEASE] ERROR: the release marks were unreadable and are dropped: ${raw.slice(0, 80)}`
  );
  store.removeItem(UPLOAD_RELEASE_MARKS_KEY);
  return {};
}

function writeMarks(store: MarkStore, marks: Record<string, string[]>): void {
  const kept = Object.fromEntries(Object.entries(marks).filter(([, ids]) => ids.length > 0));
  if (Object.keys(kept).length === 0) store.removeItem(UPLOAD_RELEASE_MARKS_KEY);
  else store.setItem(UPLOAD_RELEASE_MARKS_KEY, JSON.stringify(kept));
}

/** Writes the mark: `uploadId` of `ownerId` is owed a release. Idempotent. */
export function markUploadForRelease(
  ownerId: string,
  uploadId: string,
  log: (line: string) => void,
  store: MarkStore | null = defaultStore()
): void {
  if (!store) {
    log(`[UPLOAD-RELEASE] ERROR: no storage: session ${uploadId.slice(0, 8)}… is NOT marked`);
    return;
  }
  const marks = readMarks(store, log);
  const ids = marks[ownerId] ?? [];
  if (!ids.includes(uploadId)) marks[ownerId] = [...ids, uploadId];
  writeMarks(store, marks);
}

/** Removes the mark once the server answered. */
export function unmarkUploadRelease(
  ownerId: string,
  uploadId: string,
  log: (line: string) => void,
  store: MarkStore | null = defaultStore()
): void {
  if (!store) return;
  const marks = readMarks(store, log);
  marks[ownerId] = (marks[ownerId] ?? []).filter((id) => id !== uploadId);
  writeMarks(store, marks);
}

/** The sessions `ownerId` still owes a release on this device. */
export function uploadReleaseMarksOf(
  ownerId: string,
  log: (line: string) => void,
  store: MarkStore | null = defaultStore()
): string[] {
  return store ? [...(readMarks(store, log)[ownerId] ?? [])] : [];
}

/**
 * Drops every mark of a DELETED account: its data leaves the device, and the server ended its
 * sessions in the erasure fan-out (`cancelAllOwnedBy`).
 */
export function dropUploadReleaseMarksOf(
  ownerId: string,
  log: (line: string) => void,
  store: MarkStore | null = defaultStore()
): void {
  if (!store) return;
  const marks = readMarks(store, log);
  const n = marks[ownerId]?.length ?? 0;
  if (n === 0) return;
  delete marks[ownerId];
  writeMarks(store, marks);
  log(`[UPLOAD-RELEASE] ${n} release mark(s) of a deleted account dropped (the server ended them)`);
}

async function releaseOnce(
  release: SessionReleaser,
  uploadId: string,
  why: string,
  log: (line: string) => void
): Promise<ReleaseAnswer> {
  try {
    return await release(uploadId, why);
  } catch (e) {
    log(`[UPLOAD-RELEASE] the releaser threw for ${uploadId.slice(0, 8)}…, kept: ${String(e)}`);
    return 'unanswered';
  }
}

/**
 * Releases ONE session the durable way: mark, `DELETE`, unmark on an answer. What the outbox's
 * withdrawal and its permanent failures call (`OutboxDeps.releaseUpload`).
 */
export async function releaseUploadDurably(
  ownerId: string,
  uploadId: string,
  why: string,
  release: SessionReleaser,
  log: (line: string) => void,
  store: MarkStore | null = defaultStore()
): Promise<ReleaseAnswer> {
  markUploadForRelease(ownerId, uploadId, log, store);
  const answer = await releaseOnce(release, uploadId, why, log);
  if (answer === 'answered') unmarkUploadRelease(ownerId, uploadId, log, store);
  else
    log(
      `[UPLOAD-RELEASE] session ${uploadId.slice(0, 8)}… owed: released at the next start or reconnect`
    );
  return answer;
}

/**
 * Releases every session `ownerId` still owes, one `DELETE` each, removing the marks the server
 * answered. A pass already running for this owner is joined, never doubled.
 */
export async function sweepUploadReleaseMarks(
  ownerId: string,
  release: SessionReleaser,
  log: (line: string) => void,
  store: MarkStore | null = defaultStore()
): Promise<{ released: number; kept: number }> {
  const owed = uploadReleaseMarksOf(ownerId, log, store);
  if (owed.length === 0) return { released: 0, kept: 0 };
  log(`[UPLOAD-RELEASE] ${owed.length} session release(s) owed from an earlier run`);
  let released = 0;
  for (const uploadId of owed) {
    if ((await releaseOnce(release, uploadId, 'owed', log)) === 'answered') {
      unmarkUploadRelease(ownerId, uploadId, log, store);
      released += 1;
    }
  }
  const kept = owed.length - released;
  log(`[UPLOAD-RELEASE] owed releases: ${released} answered, ${kept} still owed`);
  return { released, kept };
}

// ── The session's drain: at startup and on every reconnect (the `pendingGroupExits` shape) ───────

interface DrainDeps {
  getUserId: () => string;
  release: SessionReleaser;
  log: (line: string) => void;
}

let registered: DrainDeps | null = null;
let unsubscribeReconnect: (() => void) | null = null;
let running: Promise<unknown> | null = null;

/** Attaches the signed-in session's drain to the reconnect edge. */
export function registerUploadReleaseDrain(deps: DrainDeps): void {
  unregisterUploadReleaseDrain();
  registered = deps;
  unsubscribeReconnect = connectivity.onReconnect(() => {
    void flushUploadReleaseMarks();
  });
}

/** Detaches it: a mark of the user who signed out must never be released with the next one's token. */
export function unregisterUploadReleaseDrain(): void {
  unsubscribeReconnect?.();
  unsubscribeReconnect = null;
  registered = null;
  running = null;
}

/**
 * Releases the registered owner's owed sessions now. Called once at startup AND on reconnect: an app
 * killed offline comes back with the link already up, so no `online` edge fires for it.
 */
export async function flushUploadReleaseMarks(): Promise<void> {
  if (!registered) return;
  if (running) {
    await running;
    return;
  }
  const { getUserId, release, log } = registered;
  const ownerId = getUserId();
  if (!ownerId) return;
  running = sweepUploadReleaseMarks(ownerId, release, log).finally(() => {
    running = null;
  });
  await running;
}
