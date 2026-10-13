/**
 * The in-app log: the app's own console lines, redacted, kept on the device in a size-bounded ring,
 * and handed over only when the member asks for it (Settings > About, {@link ./appLogExport}).
 *
 * WHY. A store build logs no JavaScript anywhere: wry forwards `console.*` to logcat only when
 * `BuildConfig.DEBUG`, WKWebView keeps it to Safari's inspector, and the old `attachConsole()` call
 * listened in the opposite direction. So the `[SELECT]`, `[QUEUE]` and `[GRAINE]` lines of a heavy
 * phone could not be read at all (docs/wiki/frontend/mobile.md#the-in-app-log).
 *
 * WHAT ENTERS. `log`, `info`, `warn` and `error` from the one console wrapper
 * (`installConsoleIdTruncation`), each line passed through {@link redactLogLine} first - the raw
 * line is never stored. `debug` does not enter: it is `Log.d` at every function entry, the volume
 * that would push the lines a reading needs out of the ring, and none of the lines asked for is
 * debug. Workers have their own console and do not enter either.
 *
 * HOW IT IS STORED, AND WHAT IT COSTS. Lines are batched in memory and written to IndexedDB
 * (`CanariDBLog`, the same database on web and in the Tauri WebView) as ONE new record per flush:
 * nothing already written is ever rewritten, so a flush writes what it adds and no more - unlike the
 * MLS state, which is rewritten whole. A flush happens when the batch reaches
 * {@link FLUSH_CHARS} or {@link FLUSH_LINES}, when the app leaves the screen, and before an export;
 * never on a timer. After the write, the oldest records are deleted until the total is under
 * {@link MAX_PERSISTED_CHARS}: the ring is bounded by SIZE.
 *
 * IT NEVER LOGS THROUGH THE CONSOLE FROM INSIDE A CAPTURE (that would recurse); its own failures
 * are written as lines of the log itself and printed through the console outside the capture.
 */
import { onAppScreenChange } from './appForeground';
import { renderLogPayload } from './Log';
import { redactLogLine } from './appLogRedact';

/** The console methods that enter the log. `debug` is deliberately absent (see the module doc). */
export type CapturedLevel = 'log' | 'info' | 'warn' | 'error';

/** The ring's bound on disk, in UTF-16 code units (a redacted line is ASCII, so ~bytes). */
export const MAX_PERSISTED_CHARS = 2 * 1024 * 1024;
/** A batch is written once it holds this much text... */
export const FLUSH_CHARS = 32 * 1024;
/** ...or this many lines, whichever comes first. */
export const FLUSH_LINES = 200;
/**
 * What the memory may hold when nothing can be written (no IndexedDB, or a failed write): the
 * oldest pending lines go first, and the export says how many.
 */
export const MAX_PENDING_CHARS = 256 * 1024;

const DB_NAME = 'CanariDBLog';
const STORE = 'chunks';
const BY_CHARS = 'byChars';

const LEVEL_LETTER: Record<CapturedLevel, string> = { log: 'L', info: 'I', warn: 'W', error: 'E' };

/** One persisted batch. The key is IndexedDB's auto-increment, so two tabs never collide. */
interface Chunk {
  chars: number;
  text: string;
}

/** Why nothing is being written, when nothing is. Shown in the export header. */
export type PersistenceState = 'ok' | 'unavailable' | 'failed' | 'discarded';

let pending: string[] = [];
let pendingChars = 0;
let droppedLines = 0;
let redactedValues = 0;
let persistence: PersistenceState = 'ok';
let persistenceError = '';
let dbPromise: Promise<IDBDatabase> | null = null;
let flushChain: Promise<void> = Promise.resolve();
let capturing = false;
let lifecycleInstalled = false;

/** Turns one console call's arguments into the text of a line. */
function renderArgs(args: readonly unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : renderLogPayload(a))).join(' ');
}

/** Two digits, or three for milliseconds. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** A local date-and-time stamp to the millisecond. The export header carries the UTC offset. */
function stamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  );
}

/** Appends one finished line to the batch, keeping the batch inside its memory bound. */
function push(line: string): void {
  pending.push(line);
  pendingChars += line.length + 1;
  while (pendingChars > MAX_PENDING_CHARS && pending.length > 1) {
    const oldest = pending.shift() ?? '';
    pendingChars -= oldest.length + 1;
    droppedLines++;
  }
  if (persistence === 'ok' && (pendingChars >= FLUSH_CHARS || pending.length >= FLUSH_LINES)) {
    void flushAppLog();
  }
}

/**
 * Records one console call. Called by the console wrapper AFTER it printed, for the levels in
 * {@link CapturedLevel} only. Never throws: a log that can break the caller is worse than none.
 */
export function captureConsoleLine(level: CapturedLevel, args: readonly unknown[]): void {
  if (capturing) return;
  capturing = true;
  try {
    const { line, redactions } = redactLogLine(renderArgs(args));
    redactedValues += redactions;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read once, never stored
    push(`${stamp(new Date())} ${LEVEL_LETTER[level]} ${line}`);
  } catch {
    droppedLines++;
  } finally {
    capturing = false;
  }
}

/** Opens (once) the log database. Rejects when IndexedDB is absent or refuses. */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this runtime'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { autoIncrement: true });
      // Lets a flush read every record's SIZE and key without reading the text.
      store.createIndex(BY_CHARS, 'chars');
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading, or the device wipe deleting the database: let go at once.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

/** Adds one chunk and deletes the oldest ones until the ring is back under its bound. */
function writeChunk(db: IDBDatabase, chunk: Chunk): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let evicted = 0;
    store.add(chunk);
    // Read back (key, size) of every record - the one just added included, a transaction sees its
    // own writes - through the index, so no text is read to decide what to drop.
    const sizes: Array<[number, number]> = [];
    const cursor = store.index(BY_CHARS).openKeyCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        sizes.push([c.primaryKey as number, c.key as number]);
        c.continue();
        return;
      }
      sizes.sort((a, b) => a[0] - b[0]);
      let total = sizes.reduce((sum, [, chars]) => sum + chars, 0);
      // The newest chunk is never evicted, even alone over the bound: it is what was just asked for.
      for (let i = 0; i < sizes.length - 1 && total > MAX_PERSISTED_CHARS; i++) {
        store.delete(sizes[i][0]);
        total -= sizes[i][1];
        evicted++;
      }
    };
    tx.oncomplete = () => resolve(evicted);
    tx.onerror = () => reject(tx.error ?? new Error('log write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('log write aborted'));
  });
}

/**
 * Writes the pending batch as one record. Serialised: a flush asked for while one runs waits for
 * it, so two batches never race for the same eviction. Resolves once everything pending at the
 * call is on disk, or once persistence has stopped.
 */
export function flushAppLog(): Promise<void> {
  flushChain = flushChain.then(async () => {
    if (persistence !== 'ok' || pending.length === 0) return;
    const lines = pending;
    const chars = pendingChars;
    pending = [];
    pendingChars = 0;
    try {
      const db = await openDb();
      await writeChunk(db, { chars, text: lines.join('\n') });
    } catch (error) {
      // Stop FIRST, so re-queuing below cannot ask for another flush.
      persistence = typeof indexedDB === 'undefined' ? 'unavailable' : 'failed';
      persistenceError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // The lines go back in front of whatever arrived meanwhile, under the same memory bound.
      const arrived = pending;
      pending = [];
      pendingChars = 0;
      for (const line of [...lines, ...arrived]) push(line);
      // Once, outside any capture (this runs after an await), so it enters the log like any line.
      console.error(
        `[APPLOG] the in-app log is no longer written to disk (${persistence}): ${persistenceError}`
      );
    }
  });
  return flushChain;
}

/** Everything in the log, oldest first, and what is known about its gaps. */
export interface AppLogSnapshot {
  text: string;
  lines: number;
  droppedLines: number;
  redactedValues: number;
  persistence: PersistenceState;
  persistenceError: string;
}

/** Reads the whole log: flushes the batch, then reads every record in key order. */
export async function readAppLog(): Promise<AppLogSnapshot> {
  await flushAppLog();
  const parts: string[] = [];
  if (persistence === 'ok') {
    const db = await openDb();
    const chunks = await new Promise<Chunk[]>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result as Chunk[]);
      request.onerror = () => reject(request.error ?? new Error('log read failed'));
    });
    for (const chunk of chunks) parts.push(chunk.text);
  }
  if (pending.length > 0) parts.push(pending.join('\n'));
  const text = parts.join('\n');
  return {
    text,
    lines: text === '' ? 0 : text.split('\n').length,
    droppedLines,
    redactedValues,
    persistence,
    persistenceError,
  };
}

/**
 * Empties the log and stops writing it for the rest of this process. The device wipe calls it
 * before deleting every `CanariDB*` database: an open connection would BLOCK that delete, and a
 * flush after it would re-create the database the survey is about to look for.
 */
export function discardAppLog(): void {
  persistence = 'discarded';
  pending = [];
  pendingChars = 0;
  if (dbPromise) {
    void dbPromise.then((db) => db.close()).catch(() => undefined);
    dbPromise = null;
  }
}

/**
 * Flushes when the app leaves the screen (backgrounded, tab hidden, page unloading): the moment
 * after which the process may be killed without another word. Idempotent.
 */
export function installAppLogFlushTriggers(): void {
  if (lifecycleInstalled || typeof window === 'undefined') return;
  lifecycleInstalled = true;
  onAppScreenChange((onScreen) => {
    if (!onScreen) void flushAppLog();
  });
  window.addEventListener('pagehide', () => void flushAppLog());
}
