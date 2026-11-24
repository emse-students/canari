import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';

/**
 * The share sheet's suggestions (sharing lot S5): which conversations, in which order, and when the
 * native side is told - only on a change, cleared when the setting is off and at sign-out, and
 * never anywhere but the phone apps - on iOS through the same two commands.
 */
const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

let platform: 'android' | 'ios' | null = 'android';
vi.mock('$lib/utils/appVersion', () => ({
  isAndroidTauriRuntime: () => platform === 'android',
  isMobileTauriRuntime: () => platform !== null,
}));

/** What the session already knows of each user's photo (`avatarPresence.known`), set per test. */
const presence = new Map<string, boolean>();
vi.mock('$lib/utils/avatarPresence', () => ({
  knownAvatarPresence: (id: string) => presence.get(id),
}));

const { selectShareTargets, syncShareTargets, MAX_SHARE_TARGETS } = await import('./shareTargets');
const {
  clearShareTargets,
  describeShareTargetsChange,
  conversationIdFromShareTarget,
  eraseAccountShortcuts,
  honourOwedNotificationErase,
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
const OWED = 'notification_shortcuts_erase_owed';
const SETTLE = 'settle_notification_shortcuts_erase';

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
  platform = 'android';
  presence.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === PUBLISH ? CLEAN : cmd === OWED ? null : 0
  );
  resetShareTargetsStateForTests();
});

describe('the photo the session knows exists', () => {
  const peer = '33333333-3333-4333-8333-333333333333';
  const dm = () => group('dm', 'Camille', 5000, { conversationType: 'direct', directPeerId: peer });

  it('travels with the id so the native side drops its remembered 404', () => {
    presence.set(peer, true);
    expect(selectShareTargets([dm()], ME, [])[0].avatar).toEqual({
      kind: 'user',
      id: peer,
      hasPhoto: true,
    });
  });

  it('is never claimed when presence said no or nothing', () => {
    presence.set(peer, false);
    expect(selectShareTargets([dm()], ME, [])[0].avatar).toEqual({ kind: 'user', id: peer });
    presence.clear();
    expect(selectShareTargets([dm()], ME, [])[0].avatar).toEqual({ kind: 'user', id: peer });
  });

  it('is published again once learned, though the list is otherwise unchanged', async () => {
    syncShareTargets(input([dm()]), 'before');
    await settle();
    presence.set(peer, true);
    syncShareTargets(input([dm()]), 'after');
    await settle();
    const sent = calls(PUBLISH).map(
      ([, a]) => (a as { targets: { avatar?: unknown }[] }).targets[0].avatar
    );
    expect(sent).toEqual([
      { kind: 'user', id: peer },
      { kind: 'user', id: peer, hasPhoto: true },
    ]);
  });
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

  it('names the picture each kind of destination is drawn with, as the picker draws it', () => {
    const salon = 'channel_22222222-2222-4222-8222-222222222222';
    const peer = '33333333-3333-4333-8333-333333333333';
    const targets = selectShareTargets(
      [
        group('dm', 'Camille', 5000, { conversationType: 'direct', directPeerId: peer }),
        group('imaged', 'Le zoo', 4000, { imageMediaId: 'img-zoo' }),
        group('plain', 'Sans image', 3000),
        group(salon, 'General', 2000, { conversationType: 'channel' }),
      ],
      ME,
      [{ name: 'BDE', channels: [{ id: salon }], imageMediaId: 'logo-bde' }]
    );
    const byId = Object.fromEntries(targets.map((t) => [t.id, t.avatar]));
    expect(byId['c:dm']).toEqual({ kind: 'user', id: peer });
    expect(byId['c:imaged']).toEqual({ kind: 'media', id: 'img-zoo' });
    // No picture known: the key is absent, so the native side draws the initials.
    expect('avatar' in targets.find((t) => t.id === 'c:plain')!).toBe(false);
    expect(byId[`c:${salon}`]).toEqual({ kind: 'media', id: 'logo-bde' });
  });

  it('draws no logo for a salon whose community has none', () => {
    const salon = 'channel_22222222-2222-4222-8222-222222222222';
    const [target] = selectShareTargets(
      [group(salon, 'General', 1000, { conversationType: 'channel' })],
      ME,
      [{ name: 'BDE', channels: [{ id: salon }], imageMediaId: null }]
    );
    expect(target.avatar).toBeUndefined();
  });

  it('publishes again when only a picture changed', async () => {
    const base = { id: 'c:a', label: 'Le zoo', link: 'fr.emse.canari://chat/a' };
    invoke.mockResolvedValue(CLEAN);
    await publishShareTargets([{ ...base, avatar: { kind: 'media', id: 'one' } }], 'test');
    await publishShareTargets([{ ...base, avatar: { kind: 'media', id: 'one' } }], 'test');
    await publishShareTargets([{ ...base, avatar: { kind: 'media', id: 'two' } }], 'test');
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, PUBLISH]);
  });
});

describe('publishing on change', () => {
  it('publishes once for an unchanged list', async () => {
    const list = [group('a', 'A', 2), group('b', 'B', 1)];
    syncShareTargets(input(list), 'test');
    syncShareTargets(input(list), 'test');
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
    syncShareTargets(input([group('a', 'A', 2), group('b', 'B', 1)]), 'test');
    syncShareTargets(input([group('a', 'A renamed', 2), group('b', 'B', 1)]), 'test');
    syncShareTargets(input([group('a', 'A renamed', 2), group('b', 'B', 3)]), 'test');
    await settle();
    expect(calls(PUBLISH)).toHaveLength(3);
  });

  it('publishes again after a failure, since the native state is then unknown', async () => {
    invoke.mockRejectedValueOnce(new Error('binder died'));
    const list = [group('a', 'A', 1)];
    syncShareTargets(input(list), 'test');
    syncShareTargets(input(list), 'test');
    await settle();
    expect(calls(PUBLISH)).toHaveLength(2);
  });

  it('publishes nothing, and reads no conversation, while signed out or before the list is read', async () => {
    const conversations = vi.fn(() => [group('a', 'A', 1)]);
    syncShareTargets({ ...input([]), signedIn: false, conversations }, 'test');
    // The next account's list still loading: its sources are not settled (reset at sign-out).
    syncShareTargets({ ...input([]), conversationsReady: false, conversations }, 'test');
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(conversations).not.toHaveBeenCalled();
  });

  it('sends the same list again when the native side left stale suggestions behind', async () => {
    invoke.mockImplementationOnce(async () => ({ present: 1, leftover: 2 }));
    const list = [group('a', 'A', 1)];
    syncShareTargets(input(list), 'test');
    syncShareTargets(input(list), 'test');
    await settle();
    expect(calls(PUBLISH)).toHaveLength(2);
  });
});

describe('saying how a publish differs from the one before', () => {
  const t = (id: string, label = id) => ({ id: `c:${id}`, label, link: `l/${id}` });

  it('names the ids that entered and left, never a label, and the survivors\x27 order', () => {
    const a = [t('aaaaaaaa1111', 'Secret name'), t('bbbbbbbb2222')];
    const b = [t('bbbbbbbb2222'), t('cccccccc3333')];
    const line = describeShareTargetsChange(a, b);
    expect(line).toBe('added [cccccccc], removed [aaaaaaaa], 0 relabelled, same order');
    expect(line).not.toContain('Secret');
  });

  it('tells a relabel and a reorder apart from a change of ids', () => {
    const a = [t('a'), t('b')];
    expect(describeShareTargetsChange(a, [t('b'), t('a', 'A renamed')])).toBe(
      'added [], removed [], 1 relabelled, reordered'
    );
    expect(describeShareTargetsChange(null, a)).toContain('unknown state');
  });

  it('a publish that follows another says, in the in-app log, how it differs', async () => {
    vi.stubGlobal('window', globalThis);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    invoke.mockResolvedValue(CLEAN);
    await publishShareTargets([t('a')], 'first');
    await publishShareTargets([t('a'), t('b')], 'second');
    const said = info.mock.calls.map((c) => c.join(' '));
    expect(said.some((l) => l.includes('published (second): added [b], removed []'))).toBe(true);
    info.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('clearing', () => {
  it('clears when the setting is off, once', async () => {
    syncShareTargets(input([group('a', 'A', 1)]), 'test');
    syncShareTargets(input([group('a', 'A', 1)], { enabled: false }), 'test');
    syncShareTargets(input([group('a', 'A', 1)], { enabled: false }), 'test');
    await settle();
    expect(calls(CLEAR)).toHaveLength(1);
    // The clear lands after the publish it follows.
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, CLEAR]);
  });

  it('clears at sign-out and lets the next account publish its own list', async () => {
    const list = [group('a', 'A', 1)];
    syncShareTargets(input(list), 'test');
    await clearShareTargets('signed out');
    // Even the SAME list is sent again: what the native side holds is now nothing.
    syncShareTargets(input(list), 'test');
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, CLEAR, PUBLISH]);
  });

  it('the sign-out reaches native even after an EMPTY publish, which already reads as "nothing"', async () => {
    syncShareTargets(input([]), 'test');
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
      cmd === PUBLISH ? publish.promise : Promise.resolve(cmd === OWED ? null : 0)
    );
    syncShareTargets(input([group('a', 'A', 1)]), 'test');
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH]);

    const erased = eraseAccountShortcuts('signed out');
    await settle();
    // Still in flight: nothing else has reached the native side yet.
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH]);

    publish.resolve(CLEAN);
    await erased;
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, CLEAR, OWED, CLEAR_CONVERSATIONS]);
  });

  it('a failed erase of the conversation shortcuts is said, never thrown', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === CLEAR_CONVERSATIONS) throw new Error('kept on record');
      return cmd === OWED ? null : 0;
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

describe('on iOS', () => {
  it('publishes and clears through the same two commands, and only when the list changed', async () => {
    platform = 'ios';
    syncShareTargets(input([group('a', 'A', 1)]), 'test');
    syncShareTargets(input([group('a', 'A', 1)]), 'test');
    syncShareTargets(input([group('a', 'A', 1)], { enabled: false }), 'test');
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([PUBLISH, CLEAR]);
    // The id iOS donates as the conversationIdentifier is Android's shortcut id.
    expect(calls(PUBLISH)[0][1]).toMatchObject({ targets: [{ id: 'c:a', label: 'A' }] });
  });

  it('erases the suggestions AND the notification donations at sign-out (owner, 2026-11-21)', async () => {
    // The notification extension donates an interaction per communication notification (a
    // sender's name and face): the same command Android's conversation shortcuts use erases them.
    platform = 'ios';
    await eraseAccountShortcuts('signed out');
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([CLEAR, OWED, CLEAR_CONVERSATIONS]);
  });

  it('erases the notification donations only once the push registration has ended (review of #3938)', async () => {
    // The end strips the extension's proof of an account; erased before it, a push landing in
    // between would donate the leaving account's sender again.
    platform = 'ios';
    const pushEnded = deferred<number | null>();
    const erased = eraseAccountShortcuts('signed out', pushEnded.promise);
    await settle();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([CLEAR]);
    pushEnded.resolve(null);
    await erased;
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([CLEAR, OWED, CLEAR_CONVERSATIONS]);
  });
});

describe('the notifications erase is owed on disk until done (review of #3938)', () => {
  /** The native side owes erase `owed` (null: none), and records what was settled. */
  function owing(owed: number | null, failErase = false) {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === OWED) return owed;
      if (cmd === CLEAR_CONVERSATIONS && failErase) throw new Error('kept on record');
      if (cmd === SETTLE) return true;
      return 0;
    });
  }

  it('the sign-out settles the erase it read as owed, once the native side answered', async () => {
    platform = 'ios';
    owing(4);
    await eraseAccountShortcuts('signed out');
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([CLEAR, OWED, CLEAR_CONVERSATIONS, SETTLE]);
    expect(calls(SETTLE)[0][1]).toEqual({ owed: 4 });
  });

  it('an erase that failed is left owed - never settled', async () => {
    platform = 'ios';
    owing(4, true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await eraseAccountShortcuts('signed out');
    expect(calls(SETTLE)).toHaveLength(0);
    error.mockRestore();
  });

  it('at launch, an erase still owed is completed and settled', async () => {
    platform = 'ios';
    owing(2);
    await honourOwedNotificationErase('launch');
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([OWED, CLEAR_CONVERSATIONS, SETTLE]);
    expect(calls(SETTLE)[0][1]).toEqual({ owed: 2 });
  });

  it('at launch, nothing owed erases nothing', async () => {
    platform = 'android';
    owing(null);
    await honourOwedNotificationErase('launch');
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([OWED]);
  });

  it('off the phone apps, nothing is asked', async () => {
    platform = null;
    await honourOwedNotificationErase('launch');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('an owed mark that cannot be read is erased anyway, accused, and never settled', async () => {
    platform = 'ios';
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === OWED) throw new Error('unreadable');
      return 0;
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await honourOwedNotificationErase('launch');
    expect(invoke.mock.calls.map(([c]) => c)).toEqual([OWED, CLEAR_CONVERSATIONS]);
    expect(String(error.mock.calls[0]?.[0])).toContain('could not be read - erasing anyway');
    error.mockRestore();
  });

  it('a sign-out erase whose ticket was settled meanwhile skips: the next account keeps its donations', async () => {
    // A signs out with ticket 3; before A's erase runs (it waits for the FCM step), B's context is
    // prepared, whose honour erases and settles mark 3. A's erase then finds nothing owed.
    platform = 'ios';
    owing(null);
    await eraseAccountShortcuts('signed out', Promise.resolve(3));
    expect(calls(CLEAR_CONVERSATIONS)).toHaveLength(0);
  });

  it('a sign-out whose mark was never written always erases, whatever ran in between', async () => {
    // No ticket: nothing proves this sign-out's erase was done, even after a honour found nothing.
    platform = 'ios';
    owing(null);
    const pushEnded = deferred<number | null>();
    const late = eraseAccountShortcuts('signed out', pushEnded.promise);
    await honourOwedNotificationErase('before the push context');
    pushEnded.resolve(null);
    await late;
    expect(calls(CLEAR_CONVERSATIONS)).toHaveLength(1);
    expect(calls(SETTLE)).toHaveLength(0);
  });
});

describe('off the phone apps', () => {
  it('neither publishes nor clears', async () => {
    platform = null;
    syncShareTargets(input([group('a', 'A', 1)]), 'test');
    syncShareTargets(input([group('a', 'A', 1)], { enabled: false }), 'test');
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

describe('the erase says its outcome at a level the exported log keeps (iPhone 12, 1.8.0-alpha.6)', () => {
  it('a performed erase is INFO, never DEBUG, and a skipped one is INFO too', async () => {
    const { Log } = await import('$lib/utils/Log');
    const info = vi.spyOn(Log, 'i').mockImplementation(() => {});
    const debug = vi.spyOn(Log, 'd').mockImplementation(() => {});
    platform = 'ios';
    invoke.mockImplementation(async (cmd: string) => (cmd === OWED ? null : 0));
    await eraseAccountShortcuts('signed out');
    const said = info.mock.calls.map(([, m]) => String(m));
    expect(said.some((m) => m.includes('conversation shortcuts erased'))).toBe(true);
    expect(debug.mock.calls.some(([, m]) => String(m).includes('shortcuts erased'))).toBe(false);
    info.mockClear();
    await honourOwedNotificationErase('launch');
    expect(
      info.mock.calls.some(([, m]) => String(m).includes('no conversation shortcuts erase owed'))
    ).toBe(true);
    info.mockRestore();
    debug.mockRestore();
  });
});
