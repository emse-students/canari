import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WP-MENTION-NAME: the names this device resolved, handed to the native push path at the moment
 * the app is hidden - the one moment before which a native mention banner cannot be drawn.
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

const { noteResolvedName, flushNameMirror, pendingMirroredNames } = await import('./nameMirror');

const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../../src-tauri');
const read = (rel: string) => readFileSync(join(TAURI, rel), 'utf8');

const ALICE = '1'.repeat(64);
const BOB = '2'.repeat(64);

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockResolvedValue(2);
  mobile = true;
  me = 'a'.repeat(64);
  // Drain whatever a previous case left.
  await flushNameMirror();
  invoke.mockReset();
  invoke.mockResolvedValue(2);
});

describe('the native name mirror', () => {
  it('writes the names learned since the last hide, once, under the signed-in account', async () => {
    noteResolvedName(ALICE.toUpperCase(), ' Alice ');
    noteResolvedName(BOB, 'Bob');
    document.dispatchEvent(new Event('visibilitychange'));
    // jsdom/happy-dom report `visible` unless told otherwise, so the hide is driven directly.
    await flushNameMirror();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('store_display_names', {
      userId: me,
      names: { [ALICE]: 'Alice', [BOB]: 'Bob' },
    });
    await flushNameMirror();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('flushes when the document is hidden, and not while it is visible', async () => {
    noteResolvedName(ALICE, 'Alice');
    const state = vi.spyOn(document, 'visibilityState', 'get');
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    state.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    state.mockRestore();
  });

  it('notes nothing a mention cannot name, nor anything off a phone', () => {
    noteResolvedName('not-a-user-id', 'X');
    noteResolvedName(ALICE, '   ');
    expect(pendingMirroredNames()).toBe(0);
    mobile = false;
    noteResolvedName(ALICE, 'Alice');
    expect(pendingMirroredNames()).toBe(0);
  });

  it("never writes one account's names under the account that signed in after it", async () => {
    noteResolvedName(ALICE, 'Alice');
    me = 'b'.repeat(64);
    await flushNameMirror();
    expect(invoke).not.toHaveBeenCalled();
    expect(pendingMirroredNames()).toBe(0);
  });

  it('keeps the names of a failed write for the next hide', async () => {
    invoke.mockRejectedValueOnce(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteResolvedName(ALICE, 'Alice');
    await flushNameMirror();
    expect(pendingMirroredNames()).toBe(1);
    expect(warn).toHaveBeenCalled();
    await flushNameMirror();
    expect(invoke).toHaveBeenLastCalledWith('store_display_names', {
      userId: me,
      names: { [ALICE]: 'Alice' },
    });
    warn.mockRestore();
  });

  it('is one command and one file name across Rust, Kotlin, Swift and ObjC', () => {
    const rust = read('src/commands/display_names.rs');
    expect(rust).toMatch(/pub\(crate\) const DISPLAY_NAMES_FILE: &str = "display_names\.json";/);
    expect(rust).toMatch(
      /fn store_display_names\(\s*app: tauri::AppHandle,\s*user_id: String,\s*names: HashMap<String, String>,/
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
