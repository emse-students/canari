import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';

/**
 * The share sheet's suggestions (sharing lot S5): which conversations, in which order, and when the
 * native side is told - only on a change, cleared when the setting is off and at sign-out, and
 * never anywhere but Android.
 */
const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

let android = true;
vi.mock('$lib/utils/appVersion', () => ({ isAndroidTauriRuntime: () => android }));

const { selectShareTargets, syncShareTargets, MAX_SHARE_TARGETS } = await import('./shareTargets');
const {
  clearShareTargets,
  conversationIdFromShareTarget,
  eraseAccountShortcuts,
  publishShareTargets,
  resetShareTargetsStateForTests,
  shareTargetId,
} = await import('./shareTargetsNative');
const { suggestionIfHeld } = await import('./shareDestinations');

const ME = '11111111-1111-4111-8111-111111111111';

function group(id: string, name: string, at: number, extra: Partial<Conversation> = {}) {
  const c = {
    id,
    name,
    contactName: name,
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    conversationType: 'group',
    lastMessageAt: at,
    ...extra,
  } as Conversation;
  return [id, c] as [string, Conversation];
}

const PUBLISH = 'plugin:gallery|publish_share_targets';
const CLEAR = 'plugin:gallery|clear_share_targets';
const CLEAR_CONVERSATIONS = 'plugin:gallery|clear_conversation_shortcuts';

/** The native publish's answer when every stale suggestion was removed. */
const CLEAN = { present: 1, leftover: 0 };

/** A native answer the test releases by hand: the call stays IN FLIGHT until then. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

function input(conversations: [string, Conversation][], over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    signedIn: true,
    conversationsReady: true,
    conversations: () => conversations,
    currentUserId: ME,
    workspaces: () => [],
    ...over,
  };
}

/** Lets the queued native calls run: each is a microtask chain the mock resolves at once. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  android = true;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === PUBLISH ? CLEAN : 0));
  resetShareTargetsStateForTests();
});

describe('selectShareTargets', () => {
  it('keeps the most recent destinations first, capped', () => {
    const list = Array.from({ length: MAX_SHARE_TARGETS + 3 }, (_, i) =>
      group(`g${i}`, `Groupe ${i}`, 1000 + i)
    );
    const targets = selectShareTargets(list, ME, []);
    expect(targets).toHaveLength(MAX_SHARE_TARGETS);
    expect(targets[0]).toEqual({
      id: `c:g${MAX_SHARE_TARGETS + 2}`,
      label: `Groupe ${MAX_SHARE_TARGETS + 2}`,
      link: `fr.emse.canari://chat/g${MAX_SHARE_TARGETS + 2}`,
    });
    expect(targets.map((t) => t.id)).toEqual(
      [...list]
        .reverse()
        .slice(0, MAX_SHARE_TARGETS)
        .map(([id]) => `c:${id}`)
    );
  });

  it('leaves out a conversation that cannot receive, and an id that is not a plain token', () => {
    const targets = selectShareTargets(
      [
        group('gone', 'Partie', 3000, { lifecycle: 'removed' }),
        group('waiting', 'En attente', 2000, { lifecycle: 'pending' }),
        group('bad/id', 'Chemin', 1500),
        group('ok', 'Reste', 1000),
      ],
      ME,
      []
    );
    expect(targets.map((t) => t.id)).toEqual(['c:ok']);
  });

  it('names a salon with its community', () => {
    const salon = 'channel_22222222-2222-4222-8222-222222222222';
    const targets = selectShareTargets(
      [group(salon, 'General', 1000, { conversationType: 'channel' })],
      ME,
      [{ name: 'BDE', channels: [{ id: salon }] }]
    );
    expect(targets[0].label).toBe('General (BDE)');
  });
});

describe('publishing on change', () => {
  it('publishes once for an unchanged list', async () => {
    const list = [group('a', 'A', 2), group('b', 'B', 1)];
    syncShareTargets(input(list));
    syncShareTargets(input(list));
    await settle();
    expect(calls(PUBLISH)).toHaveLength(1);
    expect(calls(PUBLISH)[0][1]).toEqual({
      targets: [
        { id: 'c:a', label: 'A', link: 'fr.emse.canari://chat/a' },
        { id: 'c:b', label: 'B', link: 'fr.emse.canari://chat/b' },
      ],
    });
  });

  it('publishes again on a rename and on a reorder', async () => {
    syncShareTargets(input([group('a', 'A', 2), group('b', 'B', 1)]));
    syncShareTargets(input([group('a', 'A renamed', 2), group('b', 'B', 1)]));
    syncShareTargets(input([group('a', 'A renamed', 2), group('b', 'B', 3)]));
    await settle();
    expect(calls(PUBLISH)).toHaveLength(3);
  });

  it('publishes again after a failure, since the native state is then unknown', async () => {
    invoke.mockRejectedValueOnce(new Error('binder died'));
    const list = [group('a', 'A', 1)];
    syncShareTargets(input(list));
    syncShareTargets(input(list));
    await settle();
    expect(calls(PUBLISH)).toHaveLength(2);
  });

  it('publishes nothing, and reads no conversation, while signed out or before the list is read', async () => {
    const conversations = vi.fn(() => [group('a', 'A', 1)]);
    syncShareTargets({ ...input([]), signedIn: false, conversations });
    // The next account's list still loading: its sources are not settled (reset at sign-out).
    syncShareTargets({ ...input([]), conversationsReady: false, conversations });
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(conversations).not.toHaveBeenCalled();
  });

  it('sends the same list again when the native side left stale suggestions behind', async () => {
    invoke.mockImplementationOnce(async () => ({ present: 1, leftover: 2 }));
    const list = [group('a', 'A', 1)];
    syncShareTargets(input(list));
    syncShareTargets(input(list));
    await settle();
    expect(calls(PUBLISH)).toHaveLength(2);
  });
});

describe('clearing', () => {
  it('clears when the setting is off, once', async () => {
    syncShareTargets(input([group('a', 'A', 1)]));
    syncShareTargets(input([group('a', 'A', 1)], { enabled: false }));
    syncShareTargets(input([group('a', 'A', 1)], { enabled: false }));
    await settle();
    expect(calls(CLEAR)).toHaveLength(1);
    // The clear lands after the publish it follows.
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, CLEAR]);
  });

  it('clears at sign-out and lets the next account publish its own list', async () => {
    const list = [group('a', 'A', 1)];
    syncShareTargets(input(list));
    await clearShareTargets('signed out');
    // Even the SAME list is sent again: what the native side holds is now nothing.
    syncShareTargets(input(list));
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, CLEAR, PUBLISH]);
  });

  it('the sign-out reaches native even after an EMPTY publish, which already reads as "nothing"', async () => {
    syncShareTargets(input([]));
    await settle();
    expect(calls(PUBLISH)).toHaveLength(1);
    // The setting path would skip here; the sign-out never does - only the native record knows.
    await clearShareTargets('suggestions turned off');
    expect(calls(CLEAR)).toHaveLength(0);
    await eraseAccountShortcuts('signed out');
    expect(calls(CLEAR)).toHaveLength(1);
    expect(calls(CLEAR_CONVERSATIONS)).toHaveLength(1);
  });

  it('a sign-out issued while a publish is IN FLIGHT lands after it', async () => {
    const publish = deferred<typeof CLEAN>();
    invoke.mockImplementation((cmd: string) =>
      cmd === PUBLISH ? publish.promise : Promise.resolve(0)
    );
    syncShareTargets(input([group('a', 'A', 1)]));
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH]);

    const erased = eraseAccountShortcuts('signed out');
    await settle();
    // Still in flight: nothing else has reached the native side yet.
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH]);

    publish.resolve(CLEAN);
    await erased;
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, CLEAR, CLEAR_CONVERSATIONS]);
  });

  it('a failed erase of the conversation shortcuts is said, never thrown', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === CLEAR_CONVERSATIONS) throw new Error('kept on record');
      return 0;
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(eraseAccountShortcuts('signed out')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('clears even in a fresh process, where nothing says what was published', async () => {
    await clearShareTargets('signed out');
    expect(calls(CLEAR)).toHaveLength(1);
  });
});

describe('anywhere but Android', () => {
  it('neither publishes nor clears', async () => {
    android = false;
    syncShareTargets(input([group('a', 'A', 1)]));
    syncShareTargets(input([group('a', 'A', 1)], { enabled: false }));
    await clearShareTargets('signed out');
    await eraseAccountShortcuts('signed out');
    await publishShareTargets([{ id: 'c:a', label: 'A', link: 'x' }], 'test');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the suggestion a share arrives with', () => {
  it('round-trips a conversation id through the shortcut id', () => {
    expect(conversationIdFromShareTarget(shareTargetId('abc-123'))).toBe('abc-123');
  });

  it('ignores a malformed shortcut id', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'c:',
      'chat_abc',
      'c:a/b',
      `c:${'a'.repeat(250)}`,
    ]) {
      expect(conversationIdFromShareTarget(bad)).toBeNull();
    }
  });

  it('is preselected only when the signed-in account holds that conversation', () => {
    const held = [{ id: 'a' }, { id: 'b' }];
    expect(suggestionIfHeld('b', held)).toBe('b');
    expect(suggestionIfHeld('from-another-account', held)).toBeNull();
    expect(suggestionIfHeld(null, held)).toBeNull();
  });
});
