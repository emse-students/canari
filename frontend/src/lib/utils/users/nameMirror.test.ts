// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WP-MENTION-NAME: the names this device resolved, handed to the native push path when they
 * CHANGE (one write per task, one in flight at a time), with the hide as an extra flush only, and a
 * deleted account dropped.
 *
 * Three toolchains read one FILE NAME (Rust writes it, Kotlin, Swift and ObjC read it), so the name
 * is pinned here, where all four sources can be read at once.
 */
const invoke = vi.fn();
let mobile = true;
let me: string | null = 'a'.repeat(64);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => mobile }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => me }));

const { noteResolvedName, noteDeletedAccount, flushNameMirror, pendingMirroredNames } =
  await import('./nameMirror');

const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../../src-tauri');
const read = (rel: string) => readFileSync(join(TAURI, rel), 'utf8');

const ALICE = '1'.repeat(64);
const BOB = '2'.repeat(64);

/** Lets the scheduled microtask and the write it starts run to the end. */
const settle = () => flushNameMirror();

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockResolvedValue(2);
  mobile = true;
  me = 'a'.repeat(64);
  // Drain whatever a previous case left.
  await settle();
  invoke.mockReset();
  invoke.mockResolvedValue(2);
});

describe('the native name mirror', () => {
  it('writes a burst of names ONCE, at the end of the task that learned them - no hide needed', async () => {
    noteResolvedName(ALICE.toUpperCase(), ' Alice ');
    noteResolvedName(BOB, 'Bob');
    expect(invoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('store_display_names', {
      userId: me,
      names: { [ALICE]: 'Alice', [BOB]: 'Bob' },
      removed: [],
    });
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps one write in flight, and sends what changed meanwhile right after it', async () => {
    let release!: (v: number) => void;
    invoke.mockImplementationOnce(() => new Promise<number>((r) => (release = r)));
    noteResolvedName(ALICE, 'Alice');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    noteResolvedName(BOB, 'Bob');
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    release(1);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith('store_display_names', {
      userId: me,
      names: { [BOB]: 'Bob' },
      removed: [],
    });
  });

  it('drops a deleted account, and the later of a name and a deletion wins', async () => {
    noteResolvedName(BOB, 'Bob');
    noteDeletedAccount(BOB.toUpperCase());
    await settle();
    expect(invoke).toHaveBeenCalledWith('store_display_names', {
      userId: me,
      names: {},
      removed: [BOB],
    });
  });

  it('flushes on hide as well, and not while visible', async () => {
    invoke.mockRejectedValueOnce(new Error('suspended'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteResolvedName(ALICE, 'Alice');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(pendingMirroredNames()).toBe(1);
    const state = vi.spyOn(document, 'visibilityState', 'get');
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    state.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    state.mockRestore();
    warn.mockRestore();
  });

  it('notes nothing a mention cannot name, nor anything off a phone', () => {
    noteResolvedName('not-a-user-id', 'X');
    noteResolvedName(ALICE, '   ');
    noteDeletedAccount('not-a-user-id');
    expect(pendingMirroredNames()).toBe(0);
    mobile = false;
    noteResolvedName(ALICE, 'Alice');
    expect(pendingMirroredNames()).toBe(0);
  });

  it("never writes one account's names under the account that signed in after it", async () => {
    noteResolvedName(ALICE, 'Alice');
    me = 'b'.repeat(64);
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(pendingMirroredNames()).toBe(0);
  });

  it('keeps the names of a failed write for the next change', async () => {
    invoke.mockRejectedValueOnce(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteResolvedName(ALICE, 'Alice');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(pendingMirroredNames()).toBe(1);
    noteResolvedName(BOB, 'Bob');
    await settle();
    expect(invoke).toHaveBeenLastCalledWith('store_display_names', {
      userId: me,
      names: { [ALICE]: 'Alice', [BOB]: 'Bob' },
      removed: [],
    });
    warn.mockRestore();
  });

  it('is one command and one file name across Rust, Kotlin, Swift and ObjC', () => {
    const rust = read('src/commands/display_names.rs');
    expect(rust).toMatch(/pub\(crate\) const DISPLAY_NAMES_FILE: &str = "display_names\.json";/);
    expect(rust).toMatch(
      /fn store_display_names\(\s*app: tauri::AppHandle,\s*user_id: String,\s*names: HashMap<String, String>,\s*removed: Vec<String>,/
    );
    expect(read('src/lib.rs')).toContain('store_display_names,');
    for (const native of [
      'gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt',
      'gen/apple/canari_NSE/NotificationService.swift',
      'gen/apple/Sources/canari/canari_push.mm',
    ]) {
      expect(read(native), native).toContain('"display_names.json"');
    }
  });
});
