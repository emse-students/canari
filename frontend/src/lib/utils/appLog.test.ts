// @vitest-environment happy-dom
/**
 * The in-app log's ring: what it writes, when, how much, and what it does when it cannot write.
 *
 * The write-amplification case is a MEASUREMENT, not a wish: the app already rewrites a 15 MB MLS
 * state, so this writer must cost what it adds and nothing more. It counts every character handed
 * to IndexedDB and compares it with the characters logged.
 */
import {
  IDBDatabase as FakeDatabase,
  IDBFactory,
  IDBObjectStore as FakeObjectStore,
} from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The read pass yields by line count; counted here, resolved at once so no test waits on a frame.
const yieldSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('./scheduling/yieldToMainThread', () => ({ yieldToMainThread: yieldSpy }));

// The screen signal, driven by hand: `screen.change(false)` is the app leaving the screen.
const screen = vi.hoisted(() => ({ on: true, change: (_onScreen: boolean) => {} }));
vi.mock('./appForeground', () => ({
  isAppInForeground: () => screen.on,
  onAppScreenChange: (onChange: (onScreen: boolean) => void) => {
    screen.change = onChange;
    return () => {};
  },
}));

// Which shell this is, driven by hand: the unclean-end marker is kept on the mobile shells only.
const shell = vi.hoisted(() => ({ mobile: false }));
vi.mock('./appVersion', () => ({ isMobileTauriRuntime: () => shell.mobile }));

const ON_SCREEN_KEY = 'canari_applog_on_screen';

type AppLog = typeof import('./appLog');

let appLog: AppLog;

/** A harmless line just under the per-line cap, so every stored line is the same ~400 characters. */
const LINE = `[FILL] ${'abc '.repeat(93)}`.trimEnd();
/** What one stored line adds to a chunk: the stamp and level (` L `), the line, its newline. */
const STORED = '2026-10-13 09:11:51.157 L '.length + LINE.length + 1;

/**
 * Logs `count` lines the way an app does - spread over time, the writer keeping up - rather than in
 * one synchronous burst, which the memory bound would (correctly) cut to its last 256 KB.
 */
async function logSpread(count: number, line: (i: number) => string): Promise<void> {
  const perBatch = Math.ceil(appLog.FLUSH_CHARS / STORED);
  for (let i = 0; i < count; i++) {
    appLog.captureConsoleLine('log', [line(i)]);
    if ((i + 1) % perBatch === 0) await appLog.flushAppLog();
  }
  await appLog.flushAppLog();
}

/** Every record in the log database, read directly. */
async function records(): Promise<Array<{ chars: number; text: string }>> {
  // Opening a database that does not exist yet would CREATE it, empty, under the writer's version.
  const names = (await indexedDB.databases()).map((d) => d.name);
  if (!names.includes('CanariDBLog')) return [];
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('CanariDBLog');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const all = await new Promise<Array<{ chars: number; text: string }>>((resolve) => {
    const r = db.transaction('chunks').objectStore('chunks').getAll();
    r.onsuccess = () => resolve(r.result);
  });
  db.close();
  return all;
}

beforeEach(async () => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  appLog = await import('./appLog');
});

afterEach(() => {
  appLog.discardAppLog();
  vi.restoreAllMocks();
});

describe('the batch', () => {
  it('writes nothing until it is asked to, then ONE record for the whole batch', async () => {
    appLog.captureConsoleLine('log', ['[QUEUE] one']);
    appLog.captureConsoleLine('info', ['[GRAINE] two']);
    await Promise.resolve();
    expect(await records()).toHaveLength(0);

    await appLog.flushAppLog();
    const stored = await records();
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toMatch(/ L \[QUEUE\] one\n.* I \[GRAINE\] two$/);
  });

  it('flushes by itself once it holds FLUSH_LINES lines - by count, never by a clock', async () => {
    for (let i = 0; i < appLog.FLUSH_LINES; i++) appLog.captureConsoleLine('info', [`[N] ${i}`]);
    await appLog.flushAppLog();
    const stored = await records();
    expect(stored).toHaveLength(1);
    expect(stored[0].text.split('\n')).toHaveLength(appLog.FLUSH_LINES);
  });

  it('flushes by itself once it holds FLUSH_CHARS characters', async () => {
    const needed = Math.ceil(appLog.FLUSH_CHARS / STORED);
    for (let i = 0; i < needed; i++) appLog.captureConsoleLine('log', [LINE]);
    // No explicit flush: the batch must already be on its way.
    await vi.waitFor(async () => expect(await records()).toHaveLength(1));
  });

  it('stores the REDACTED line, never the raw one', async () => {
    appLog.captureConsoleLine('error', [
      '[LOGIN] failed for jean@emse.fr pin=1234',
      new Error('x'),
    ]);
    const { text, redactedValues } = await appLog.readAppLog();
    expect(text).not.toContain('jean@emse.fr');
    expect(text).not.toContain('1234');
    expect(text).toContain('[LOGIN] failed for [email] pin=[redacted] Error: x');
    expect(redactedValues).toBe(2);
  });

  it("keeps a DOMException's name and message - the page crash line (v1.3.0-alpha.2)", async () => {
    const crash = new DOMException('[object Object] could not be cloned.', 'DataCloneError');
    appLog.captureConsoleLine('error', [
      '[App] page crash on /bookings/spaces/[spaceId]/edit:',
      crash,
    ]);
    const { text } = await appLog.readAppLog();
    expect(text).toMatch(
      / E \[App\] page crash on \/bookings\/spaces\/\[spaceId\]\/edit: DataCloneError: \[object Object\] could not be cloned\.$/m
    );
  });

  it('renders an object argument as text, under the same redaction', async () => {
    appLog.captureConsoleLine('log', ['[WS] frame', { kind: 'msg', body: 'see you at 6' }]);
    const { text } = await appLog.readAppLog();
    expect(text).toContain('[WS] frame {"kind":"msg","body":"[12 chars]"}');
  });

  it('keeps the order across flushes, and what arrived during one', async () => {
    appLog.captureConsoleLine('log', ['[A] first']);
    const flushing = appLog.flushAppLog();
    appLog.captureConsoleLine('log', ['[A] second']);
    await flushing;
    appLog.captureConsoleLine('log', ['[A] third']);
    const { text } = await appLog.readAppLog();
    expect(text.split('\n').map((l) => l.replace(/^.* L /, ''))).toEqual([
      '[A] first',
      '[A] second',
      '[A] third',
    ]);
  });
});

describe('lines an OLDER build stored are redacted on the way out', () => {
  /** Writes one record the way a build before #1839 did: its lines redacted under weaker rules. */
  async function storeOldChunk(lines: string[]): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('CanariDBLog', 1);
      r.onupgradeneeded = () => {
        r.result
          .createObjectStore('chunks', { autoIncrement: true })
          .createIndex('byChars', 'chars');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const text = lines.join('\n');
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').add({ chars: text.length + 1, text });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  // Read on the Mi 9T export of v1.2.7-alpha.2: lines written by v1.2.7-alpha.1, before #1839.
  const OLD = [
    '2026-10-13 22:41:07.512 L [SEND] handleSendChat: contact="jolan" text="bisous" files=0',
    '2026-10-13 22:41:09.004 L [SEND] handleSendChat: contact="jolan" text="ok" files=0',
    '2026-10-13 22:41:10.300 I [DRAFT] text=hello',
    '2026-10-13 22:41:11.000 L [QUEUE] drained 3 kind=poll',
  ];

  it('comes out redacted by the rules of THIS build, stamp and level intact', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await storeOldChunk(OLD);
    const { text, redactedValues } = await appLog.readAppLog();
    expect(info).toHaveBeenCalledWith(
      '[APPLOG] 5 values redacted at read, in 3 lines an older build stored'
    );
    expect(text).not.toContain('bisous');
    expect(text).not.toContain('jolan');
    expect(text).not.toContain('"ok"');
    expect(text).not.toContain('hello');
    expect(text.split('\n').slice(0, 4)).toEqual([
      '2026-10-13 22:41:07.512 L [SEND] handleSendChat: contact="[5 chars]" text="[6 chars]" files=0',
      '2026-10-13 22:41:09.004 L [SEND] handleSendChat: contact="[5 chars]" text="[2 chars]" files=0',
      '2026-10-13 22:41:10.300 I [DRAFT] text=[5 chars]',
      '2026-10-13 22:41:11.000 L [QUEUE] drained 3 kind=poll',
    ]);
    // Counted in the export header with the others.
    expect(redactedValues).toBe(5);
  });

  it('leaves a line THIS build stored unchanged, and counts it once', async () => {
    appLog.captureConsoleLine('log', [
      '[SEND] handleSendChat: contact="jolan" text="bisous" files=0',
    ]);
    await appLog.flushAppLog();
    const [record] = await records();
    const { text, redactedValues } = await appLog.readAppLog();
    expect(text).toBe(record.text);
    expect(redactedValues).toBe(2);
  });

  it('never claims an older build for lines THIS build stored, capped ones included', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    appLog.captureConsoleLine('log', [`[DUMP] ${'name: Jean Dupont, '.repeat(60)}`]);
    appLog.captureConsoleLine('log', ['[SEND] handleSendChat: contact="jolan" text="ok" files=0']);
    await appLog.flushAppLog();
    const [record] = await records();
    const { text } = await appLog.readAppLog();
    expect(text).toBe(record.text);
    expect(info).not.toHaveBeenCalled();
  });

  it('yields to the main thread every READ_BATCH_LINES lines, by count', async () => {
    const count = appLog.READ_BATCH_LINES * 3 + 1;
    await storeOldChunk(
      Array.from({ length: count }, (_, i) => `2026-10-13 22:41:07.512 L [DRAFT] ${i} text=hello`)
    );
    yieldSpy.mockClear();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { text, lines } = await appLog.readAppLog();
    expect(yieldSpy).toHaveBeenCalledTimes(3);
    expect(lines).toBe(count);
    expect(text).not.toContain('hello');
  });
});

describe('the ring is bounded by SIZE', () => {
  it('drops the oldest records once the total passes MAX_PERSISTED_CHARS, never the newest', async () => {
    const count = Math.ceil((appLog.MAX_PERSISTED_CHARS * 1.5) / STORED);
    await logSpread(count, (i) => `[RING] ${i} ${LINE}`);

    const stored = await records();
    const total = stored.reduce((sum, r) => sum + r.chars, 0);
    expect(total).toBeLessThanOrEqual(appLog.MAX_PERSISTED_CHARS);
    expect(total).toBeGreaterThan(appLog.MAX_PERSISTED_CHARS - appLog.FLUSH_CHARS - STORED);
    expect(stored.at(-1)?.text).toContain(`[RING] ${count - 1} `);
    expect(stored[0].text).not.toContain('[RING] 0 ');
  });

  it('WRITES WHAT IT ADDS AND NOTHING MORE: one add per batch, no rewrite, amplification 1.0', async () => {
    const addSpy = vi.spyOn(FakeObjectStore.prototype, 'add');
    const putSpy = vi.spyOn(FakeObjectStore.prototype, 'put');

    // ~3 MB of lines: past the ring's bound, so eviction runs on most flushes.
    const count = Math.ceil((3 * 1024 * 1024) / STORED);
    await logSpread(count, () => LINE);

    const added = addSpy.mock.calls.map(([value]) => (value as { text: string }).text.length);
    const written = added.reduce((a, b) => a + b, 0);
    const logged = count * STORED;
    // Never an overwrite of a record already on disk...
    expect(putSpy).not.toHaveBeenCalled();
    // ...and every character handed to IndexedDB is a character logged (minus each batch's last
    // newline): the write amplification of the log itself is 1.0.
    expect(written).toBe(logged - added.length);
    // In batches of FLUSH_CHARS, not one write per line.
    expect(added.length).toBe(
      Math.ceil(logged / (Math.ceil(appLog.FLUSH_CHARS / STORED) * STORED))
    );
  });
});

describe('when nothing can be written', () => {
  it('says why, keeps a bounded tail in memory, and counts what it dropped', async () => {
    vi.resetModules();
    // @ts-expect-error -- a runtime with no IndexedDB at all
    delete globalThis.indexedDB;
    appLog = await import('./appLog');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const count = Math.ceil((appLog.MAX_PENDING_CHARS * 2) / STORED);
    for (let i = 0; i < count; i++) appLog.captureConsoleLine('log', [LINE]);
    const snapshot = await appLog.readAppLog();

    expect(snapshot.persistence).toBe('unavailable');
    expect(snapshot.text.length).toBeLessThanOrEqual(appLog.MAX_PENDING_CHARS);
    expect(snapshot.droppedLines).toBeGreaterThan(0);
    // Said ONCE, not once per batch.
    expect(error).toHaveBeenCalledTimes(1);
    globalThis.indexedDB = new IDBFactory();
  });

  it('a write ON screen that fails stops writing, and the export still carries what was stored', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    appLog.captureConsoleLine('log', ['[A] stored earlier']);
    await appLog.flushAppLog();
    const transaction = vi
      .spyOn(FakeDatabase.prototype, 'transaction')
      .mockImplementationOnce(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    appLog.captureConsoleLine('log', ['[A] refused']);
    await appLog.flushAppLog();
    transaction.mockRestore();

    const snapshot = await appLog.readAppLog();
    expect(snapshot.persistence).toBe('failed');
    // The 1.2.9-alpha.3 export held only the memory tail: the ring on disk must come out too.
    expect(snapshot.text).toMatch(/\[A\] stored earlier[\s\S]*\[A\] refused/);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('a write the WebView suspension cuts short (iPhone, 1.2.9-alpha.3)', () => {
  it('is not a storage failure: the lines are kept and written once the app is back on screen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    appLog.installAppLogFlushTriggers();
    appLog.captureConsoleLine('log', ['[A] before']);
    await appLog.flushAppLog();

    // WebKit aborts the transaction in flight as it suspends the backgrounded WebView.
    vi.spyOn(FakeDatabase.prototype, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('Transaction aborted', 'AbortError');
    });
    appLog.captureConsoleLine('log', ['[LIFECYCLE] App in background']);
    screen.change(false);
    await appLog.flushAppLog();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[APPLOG] a write was cut short'));

    // Off screen, the batch thresholds do not ask the suspended WebView again.
    const added = vi.spyOn(FakeObjectStore.prototype, 'add');
    for (let i = 0; i < appLog.FLUSH_LINES; i++) appLog.captureConsoleLine('log', [`[B] ${i}`]);
    await Promise.resolve();
    expect(added).not.toHaveBeenCalled();

    screen.change(true);
    await appLog.flushAppLog();
    const text = (await records()).map((r) => r.text).join('\n');
    expect(text).toMatch(/\[A\] before[\s\S]*App in background[\s\S]*\[B\] 199/);
    const snapshot = await appLog.readAppLog();
    expect(snapshot.persistence).toBe('ok');
  });

  it('an abort delivered on RESUME, after the app is back, is written again at once - no hold', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    appLog.installAppLogFlushTriggers();
    appLog.captureConsoleLine('log', ['[A] before']);
    await appLog.flushAppLog();

    // WebKit: the write began off screen, the screen-on event ran, THEN the abort arrived.
    vi.spyOn(FakeDatabase.prototype, 'transaction').mockImplementationOnce(() => {
      screen.change(true);
      throw new DOMException('Transaction aborted', 'AbortError');
    });
    appLog.captureConsoleLine('log', ['[LIFECYCLE] App in background']);
    screen.change(false);
    await appLog.flushAppLog();
    await appLog.flushAppLog();
    expect(error).not.toHaveBeenCalled();
    expect((await records()).map((r) => r.text).join('\n')).toContain('App in background');

    // Not held: the batch thresholds write again on their own.
    const added = vi.spyOn(FakeObjectStore.prototype, 'add');
    for (let i = 0; i < appLog.FLUSH_LINES; i++) appLog.captureConsoleLine('log', [`[B] ${i}`]);
    await appLog.flushAppLog();
    expect(added).toHaveBeenCalled();
  });
});

describe('the device wipe', () => {
  it('empties the log, stops writing it, and lets the database be deleted', async () => {
    appLog.captureConsoleLine('log', ['[A] before']);
    await appLog.flushAppLog();
    appLog.discardAppLog();
    appLog.captureConsoleLine('log', ['[A] after']);
    await appLog.flushAppLog();

    const outcome = await new Promise<string>((resolve) => {
      const r = indexedDB.deleteDatabase('CanariDBLog');
      r.onsuccess = () => resolve('deleted');
      r.onblocked = () => resolve('blocked');
    });
    expect(outcome).toBe('deleted');
    const dbs = await indexedDB.databases();
    expect(dbs.map((d) => d.name)).not.toContain('CanariDBLog');
    expect((await appLog.readAppLog()).persistence).toBe('discarded');
  });

  it('a write the wipe cut short stays discarded, never reported as a storage failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    appLog.captureConsoleLine('log', ['[A] before']);
    await appLog.flushAppLog(); // the connection is open from here on
    // The wipe lands while the next write is in flight: its connection is closed under it.
    vi.spyOn(FakeDatabase.prototype, 'transaction').mockImplementation(() => {
      appLog.discardAppLog();
      throw new DOMException('The database connection is closing.', 'InvalidStateError');
    });
    appLog.captureConsoleLine('log', ['[A] during']);
    await appLog.flushAppLog();

    const snapshot = await appLog.readAppLog();
    expect(snapshot.persistence).toBe('discarded');
    expect(snapshot.text).not.toContain('[A] during');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a crash must not take the lines that explain it (call killed during setup)', () => {
  it('an ERROR line is on disk at once, with the batch before it; L, I and W lines are not', async () => {
    appLog.captureConsoleLine('log', ['[A] quiet']);
    appLog.captureConsoleLine('info', ['[A] quiet too']);
    appLog.captureConsoleLine('warn', ['[A] a warning']);
    await Promise.resolve();
    expect(await records()).toHaveLength(0);

    appLog.captureConsoleLine('error', ['[A] something is wrong']);
    await appLog.flushAppLog();
    const text = (await records()).map((r) => r.text).join('\n');
    expect(text).toMatch(
      /quiet[\s\S]*quiet too[\s\S]* W \[A\] a warning[\s\S]* E \[A\] something is wrong/
    );
  });

  it('a storm of events cannot leave more than MAX_PERSISTED_RECORDS records, oldest first out', async () => {
    const total = appLog.MAX_PERSISTED_RECORDS + 40;
    for (let i = 0; i < total; i++) {
      appLog.captureConsoleLine('error', [`[STORM] ${i}`]);
      await appLog.flushAppLog();
    }
    const stored = await records();
    expect(stored.length).toBeLessThanOrEqual(appLog.MAX_PERSISTED_RECORDS);
    const text = stored.map((r) => r.text).join('\n');
    expect(text).not.toContain('[STORM] 0\n');
    expect(text).toContain(`[STORM] ${total - 1}`);
  }, 60_000);

  it('a storm of warnings coalesces: writes follow the write speed, never the line count', async () => {
    const added = vi.spyOn(FakeObjectStore.prototype, 'add');
    for (let i = 0; i < 100; i++) appLog.captureConsoleLine('error', [`[STORM] ${i}`]);
    await appLog.flushAppLog();
    // The first request starts a write that takes everything pending; none of the other 99 queued one.
    expect(added.mock.calls.length).toBe(1);
    const text = (await records()).map((r) => r.text).join('\n');
    expect(text).toContain('[STORM] 99');
  });

  it('a milestone writes the batch and names itself in the log', async () => {
    appLog.captureConsoleLine('log', ['[Call] ringing']);
    await appLog.flushAppLogAtMilestone('call start');
    const text = (await records()).map((r) => r.text).join('\n');
    expect(text).toMatch(/\[Call\] ringing\n.* I \[APPLOG\] milestone: call start$/);
  });

  it('asks for no write when nothing is pending, and none once persistence has stopped', async () => {
    const added = vi.spyOn(FakeObjectStore.prototype, 'add');
    appLog.discardAppLog();
    await appLog.flushAppLogAtMilestone('call end');
    expect(added).not.toHaveBeenCalled();
  });
});

describe('an unclean end is reported at the next boot', () => {
  const tauri = () => {
    shell.mobile = true;
  };

  beforeEach(() => {
    localStorage.clear();
    screen.on = true;
  });

  afterEach(() => {
    shell.mobile = false;
    localStorage.clear();
  });

  /** One process of the app: boots, logs, and is killed (the module state is thrown away). */
  async function nextProcess(): Promise<void> {
    appLog.discardAppLog();
    vi.resetModules();
    appLog = await import('./appLog');
  }

  it('a session killed ON screen is reported once, with the last written line', async () => {
    tauri();
    appLog.installAppLogFlushTriggers();
    appLog.captureConsoleLine('log', ['[Call] before the death']);
    await appLog.flushAppLog();
    await nextProcess();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appLog.installAppLogFlushTriggers();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[APPLOG\] the previous session ended while on screen \(killed or crashed\) - last written line at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/
      )
    );
  });

  it('a session that left the screen first is NOT reported - a background jetsam is normal', async () => {
    tauri();
    appLog.installAppLogFlushTriggers();
    screen.change(false);
    await nextProcess();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appLog.installAppLogFlushTriggers();
    await appLog.flushAppLog();
    expect(warn).not.toHaveBeenCalled();
  });

  it('the marker is cleared at the leave-screen edge even when that flush is cut short', async () => {
    tauri();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    appLog.installAppLogFlushTriggers();
    expect(localStorage.getItem(ON_SCREEN_KEY)).not.toBeNull();
    appLog.captureConsoleLine('log', ['[A] before']);
    await appLog.flushAppLog(); // the connection is open from here on
    vi.spyOn(FakeDatabase.prototype, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('Transaction aborted', 'AbortError');
    });
    appLog.captureConsoleLine('log', ['[A] pending']);
    screen.change(false);
    await appLog.flushAppLog();
    expect(localStorage.getItem(ON_SCREEN_KEY)).toBeNull();
    screen.change(true);
    expect(localStorage.getItem(ON_SCREEN_KEY)).not.toBeNull();
  });

  it('the marker outlives the leave-screen write until it lands - cleared only then (owner log, 2026-11-25)', async () => {
    tauri();
    appLog.installAppLogFlushTriggers();
    appLog.captureConsoleLine('log', ['[A] the last minutes']);
    screen.change(false);
    // Synchronously after the edge, the write is still on its way: the marker says so.
    expect(localStorage.getItem(ON_SCREEN_KEY)).toMatch(/^leaving:\d+$/);
    await appLog.flushAppLog();
    expect(localStorage.getItem(ON_SCREEN_KEY)).toBeNull();
    expect((await records()).map((r) => r.text).join(' ')).toContain('[A] the last minutes');
  });

  it('a session killed DURING the leave-screen write is reported at the next boot - neutrally, at INFO', async () => {
    tauri();
    appLog.installAppLogFlushTriggers();
    // The database never answers: the process is killed before the leave-screen write lands.
    const open = vi
      .spyOn(indexedDB, 'open')
      .mockImplementation(() => ({}) as unknown as IDBOpenDBRequest);
    appLog.captureConsoleLine('log', ['[A] lost with the kill']);
    screen.change(false);
    await Promise.resolve();
    expect(localStorage.getItem(ON_SCREEN_KEY)).toMatch(/^leaving:\d+$/);
    open.mockRestore();
    await nextProcess();

    // A kill and a suspended WebView reclaimed in the background leave the same marker: the line
    // accuses neither, and a normal reclaim is never a warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    appLog.installAppLogFlushTriggers();
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[APPLOG\] the previous session's leave-screen write never settled \(killed while leaving, or suspended and reclaimed in background\) - left the screen at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}, last written line at /
      )
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('a return to the screen during the leave-screen write keeps the marker the return set', async () => {
    tauri();
    appLog.installAppLogFlushTriggers();
    appLog.captureConsoleLine('log', ['[A] pending']);
    screen.change(false);
    screen.change(true);
    await appLog.flushAppLog();
    expect(localStorage.getItem(ON_SCREEN_KEY)).toBe('1');
  });

  it('two leave edges in a row (pagehide, then the screen signal) clear the marker once both settle', async () => {
    tauri();
    appLog.installAppLogFlushTriggers();
    appLog.captureConsoleLine('log', ['[A] first']);
    window.dispatchEvent(new Event('pagehide'));
    appLog.captureConsoleLine('log', ['[A] second']);
    screen.change(false);
    expect(localStorage.getItem(ON_SCREEN_KEY)).toMatch(/^leaving:\d+$/);
    await appLog.flushAppLog();
    expect(localStorage.getItem(ON_SCREEN_KEY)).toBeNull();
    const text = (await records()).map((r) => r.text).join(' ');
    expect(text).toContain('[A] first');
    expect(text).toContain('[A] second');
  });

  it('a boot while the app is off screen sets no marker', async () => {
    tauri();
    screen.on = false;
    appLog.installAppLogFlushTriggers();
    expect(localStorage.getItem(ON_SCREEN_KEY)).toBeNull();
  });

  it('is kept on the mobile shells only - a second browser tab or a desktop quit is not a crash', async () => {
    appLog.installAppLogFlushTriggers();
    await nextProcess();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appLog.installAppLogFlushTriggers();
    await appLog.flushAppLog();
    expect(warn).not.toHaveBeenCalled();
  });
});
