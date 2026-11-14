// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The nicknames a notification may show, handed to the native push path (owner, 2026-11-14): one
 * write per task, one in flight at a time, a failed write kept, one account's changes never written
 * under the next, and the sign-out removing the copy. Rust writes the file, Kotlin, Swift and ObjC
 * read it: its name is pinned here, where every source can be read at once.
 */
const invoke = vi.fn();
let mobile = true;
let me: string | null = 'a'.repeat(64);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => mobile }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => me }));

const {
  noteMirroredNickname,
  noteMirroredSalon,
  flushNicknameMirror,
  forgetNicknameMirror,
  noteMirroredScopeRestated,
  noteMirrorSessionStart,
  pendingMirroredNicknames,
} = await import('./nicknameMirror');

const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../../src-tauri');
const read = (rel: string) => readFileSync(join(TAURI, rel), 'utf8');

const BOB = '2'.repeat(64);

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockResolvedValue(1);
  mobile = true;
  me = 'a'.repeat(64);
  await flushNicknameMirror();
  invoke.mockReset();
  invoke.mockResolvedValue(1);
});

describe('the native nickname mirror', () => {
  it('writes a burst once, the later fact for one member winning, with the salons placed', async () => {
    noteMirroredNickname('g1', BOB.toUpperCase(), 'Bobby');
    noteMirroredNickname('g1', BOB, 'Capitaine');
    noteMirroredNickname('community:w1', BOB, null);
    noteMirroredSalon('channel_c1', 'community:w1');
    expect(invoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('store_conversation_nicknames', {
      userId: me,
      changes: [
        { scope: 'g1', memberId: BOB, nickname: 'Capitaine' },
        { scope: 'community:w1', memberId: BOB, nickname: null },
      ],
      channels: [{ channelId: 'c1', scope: 'community:w1' }],
      restatedScopes: [],
    });
  });

  it('restates a scope whole: a change noted before the restatement is superseded by it', async () => {
    noteMirroredNickname('community:w1', BOB, 'Old');
    noteMirroredNickname('g1', BOB, 'Kept');
    noteMirroredScopeRestated('community:w1');
    noteMirroredNickname('community:w1', BOB, 'New');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls[0][1]).toMatchObject({
      changes: [
        { scope: 'g1', memberId: BOB, nickname: 'Kept' },
        { scope: 'community:w1', memberId: BOB, nickname: 'New' },
      ],
      restatedScopes: ['community:w1'],
    });
  });

  it("writes at a session's start even with nothing to say, so the copy names this account", async () => {
    noteMirrorSessionStart();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('store_conversation_nicknames', {
      userId: me,
      changes: [],
      channels: [],
      restatedScopes: [],
    });
  });

  it('lets a write already in flight land before the sign-out removes the copy', async () => {
    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise((r) => (release = () => r(1))));
    noteMirroredNickname('g1', BOB, 'X');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const forgetting = forgetNicknameMirror(me!);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    release();
    await forgetting;
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      'store_conversation_nicknames',
      'forget_conversation_nicknames',
    ]);
  });

  it('notes nothing off a phone', () => {
    mobile = false;
    noteMirroredNickname('g1', BOB, 'X');
    expect(pendingMirroredNicknames()).toBe(0);
  });

  it("never writes one account's nicknames under the account that signed in after it", async () => {
    noteMirroredNickname('g1', BOB, 'X');
    me = 'b'.repeat(64);
    await flushNicknameMirror();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the changes of a failed write for the next one', async () => {
    invoke.mockRejectedValueOnce(new Error('io'));
    noteMirroredNickname('g1', BOB, 'X');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await flushNicknameMirror();
    await flushNicknameMirror();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({
      changes: [{ scope: 'g1', memberId: BOB, nickname: 'X' }],
    });
    expect(pendingMirroredNicknames()).toBe(0);
  });

  it("removes the account's copy at sign-out, and drops what it had noted", async () => {
    noteMirroredNickname('g1', BOB, 'X');
    await forgetNicknameMirror(me!);
    expect(invoke).toHaveBeenCalledWith('forget_conversation_nicknames', { userId: me });
    expect(pendingMirroredNicknames()).toBe(0);
  });

  it('is one pair of commands and one file name across Rust, Kotlin, Swift and ObjC', () => {
    const rust = read('src/commands/conversation_nicknames.rs');
    expect(rust).toContain('"conversation_nicknames.json"');
    expect(read('src/lib.rs')).toContain('store_conversation_nicknames,');
    expect(read('src/lib.rs')).toContain('forget_conversation_nicknames,');
    for (const native of [
      'gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt',
      'gen/apple/canari_NSE/NotificationService.swift',
      'gen/apple/Sources/canari/canari_push.mm',
    ]) {
      expect(read(native), native).toContain('"conversation_nicknames.json"');
    }
  });
});
