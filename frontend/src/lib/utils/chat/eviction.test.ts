import { describe, it, expect, vi } from 'vitest';
import {
  membershipIsDurablyLost,
  readLocalMembership,
  retireIfEvicted,
  retractEvictionNotice,
} from './eviction';
import type { Conversation } from '$lib/types';

/** Minimal conversation row: only the fields the retire path reads. */
function convo(id: string, lifecycle: Conversation['lifecycle'] = 'active'): Conversation {
  return {
    id,
    name: id,
    contactName: id,
    lifecycle,
    mlsStateHex: null,
    messages: [],
  } as unknown as Conversation;
}

function deps(
  active: () => Promise<boolean>,
  conversations: Map<string, Conversation>,
  log = vi.fn()
) {
  return {
    mlsService: { isGroupActive: vi.fn(active) },
    conversations,
    groupId: 'g1',
    evidence: 'remove-commit' as const,
    saveConversation: vi.fn(async () => {}),
    log,
  };
}

describe('retireIfEvicted - the Remove commit is authoritative', () => {
  it('retires the conversation when this device is no longer a member', async () => {
    const conversations = new Map([['g1', convo('g1')]]);
    const d = deps(async () => false, conversations);

    expect(await retireIfEvicted(d)).toBe(true);
    expect(conversations.get('g1')!.lifecycle).toBe('removed');
    expect(d.saveConversation).toHaveBeenCalledWith('g1');
  });

  it('does nothing while this device is still a member', async () => {
    const conversations = new Map([['g1', convo('g1')]]);
    const d = deps(async () => true, conversations);

    expect(await retireIfEvicted(d)).toBe(false);
    expect(conversations.get('g1')!.lifecycle).toBe('active');
  });

  it('is idempotent: a replayed Remove commit changes nothing and says so', async () => {
    // Commits are replayed - by a history drain, by a reconnect. The second application must not
    // re-write the row or re-log as though something had just happened.
    const conversations = new Map([['g1', convo('g1', 'removed')]]);
    const log = vi.fn();
    const d = deps(async () => false, conversations, log);

    expect(await retireIfEvicted(d)).toBe(false);
    expect(conversations.get('g1')!.lifecycle).toBe('removed');
    expect(d.saveConversation).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('already retired');
  });

  it('never reads a failed membership query as an eviction', async () => {
    // The two are opposite facts. A group not held locally throws here, and answering "evicted" to
    // that would retire conversations this device has merely not loaded yet.
    const conversations = new Map([['g1', convo('g1')]]);
    const log = vi.fn();
    const d = deps(async () => {
      throw new Error('Group not found: g1');
    }, conversations);
    d.log = log;

    expect(await retireIfEvicted(d)).toBe(false);
    expect(conversations.get('g1')!.lifecycle).toBe('active');
    // Swallowed, but never silently: this is the branch that would hide an eviction.
    expect(log.mock.calls.flat().join(' ')).toContain('could not be read');
  });

  it('leaves a conversation it has no row for alone', async () => {
    const conversations = new Map<string, Conversation>();
    const d = deps(async () => false, conversations);

    expect(await retireIfEvicted(d)).toBe(false);
    expect(d.saveConversation).not.toHaveBeenCalled();
  });
});

describe('readLocalMembership - three answers, and the third is the point', () => {
  const read = (active: () => Promise<boolean>, log = vi.fn()) =>
    readLocalMembership({
      mlsService: { isGroupActive: vi.fn(active) },
      groupId: 'g1',
      context: 'before verifying against the server',
      log,
    });

  it('reports membership as OpenMLS holds it', async () => {
    expect(await read(async () => true)).toBe(true);
    expect(await read(async () => false)).toBe(false);
  });

  // THE ONE THAT MATTERS. `null` and `false` are different facts, and a caller that retires a
  // conversation on `false` would wipe every conversation whose MLS group is not loaded if an
  // unreadable state collapsed into a "no".
  it('answers null - never false - when the local state cannot say', async () => {
    const log = vi.fn();
    const out = await read(async () => {
      throw new Error('Group not found: g1');
    }, log);

    expect(out).toBeNull();
    expect(out).not.toBe(false);
    expect(log.mock.calls.flat().join(' ')).toContain('could not be read');
  });

  // The caller is named in the line because this is the branch that would hide an eviction: a run
  // has to be able to see which decision it was about to inform.
  it('names its caller in the swallowed branch', async () => {
    const log = vi.fn();
    await read(async () => {
      throw new Error('WASM client not ready');
    }, log);

    expect(log.mock.calls.flat().join(' ')).toContain('before verifying against the server');
  });

  // `retireIfEvicted` reads through this helper now, and the harness classifier pins that exact
  // wording as a line which must break `clean` (tools/cross-client-harness/classify-selftest.mjs).
  // Refactoring the read must not have renamed the log line out from under it.
  it('keeps the wording retireIfEvicted has always logged', async () => {
    const log = vi.fn();
    await retireIfEvicted({
      mlsService: {
        isGroupActive: vi.fn(async () => {
          throw new Error('WASM client not ready');
        }),
      },
      conversations: new Map([['g1', convo('g1')]]),
      groupId: 'g1',
      evidence: 'remove-commit',
      saveConversation: vi.fn(async () => {}),
      log,
    });

    expect(log.mock.calls.flat().join(' ')).toContain('could not be read after a commit');
  });
});

describe('membershipIsDurablyLost - the guard on the members-only endpoint', () => {
  /**
   * THIS IS THE PREDICATE THAT DECIDES WHETHER A REQUEST IS MADE AT ALL, so what it must defend is
   * not its own truth table but its AGREEMENT WITH THE WRITER of the fact. Asserting
   * `lifecycle === 'removed'` twice - here and in the source - would be one belief written twice,
   * and would still pass on the day `retireConversation` starts recording eviction some other way.
   * So the eviction is produced by `retireIfEvicted` and the predicate is asked about the row it
   * actually left behind.
   */
  it('answers yes about a row that retireIfEvicted has just retired', async () => {
    const conversations = new Map([['g1', convo('g1')]]);
    expect(membershipIsDurablyLost(conversations.get('g1'))).toBe(false);

    await retireIfEvicted({
      mlsService: { isGroupActive: vi.fn(async () => false) },
      conversations,
      groupId: 'g1',
      evidence: 'remove-commit',
      saveConversation: vi.fn(async () => {}),
      log: vi.fn(),
    });

    expect(membershipIsDurablyLost(conversations.get('g1'))).toBe(true);
  });

  it('answers no while this device is still a member', () => {
    expect(membershipIsDurablyLost(convo('g1', 'active'))).toBe(false);
  });

  // A conversation still being established is not one we were thrown out of, and its roster is the
  // thing the caller is waiting for. Suppressing the request here would stall the invite it needs.
  it('answers no about a pending conversation', () => {
    expect(membershipIsDurablyLost(convo('g1', 'pending'))).toBe(false);
  });

  // A group id naming no row records NOTHING, so it cannot record a loss. Answering yes would
  // silently suppress the request and turn a lookup bug into an empty roster nobody investigates.
  it('answers no about a row it cannot find, rather than suppressing the request', () => {
    expect(membershipIsDurablyLost(undefined)).toBe(false);
  });
});

/**
 * THE REMOVE HALF OF OUR OWN RE-ADMISSION IS NOT AN EVICTION.
 *
 * MLS cannot Welcome a leaf still in the tree, so the member answering a `welcome_request` removes
 * us and adds us back. The Remove arrives alone and is indistinguishable from a real exclusion at
 * the frame - same signer, same merged state, same `isGroupActive === false`. Read as one it wrote
 * a PERMANENT notice into the thread that the Welcome falsified three seconds later, and nothing
 * retracts a notice: measured on a production handset on 2026-09-15, where the user was still
 * reading "vous ne pouvez plus envoyer ni recevoir" in a conversation that worked.
 *
 * The assertions are about what is NOT written, because that is what the user met: no `removed`,
 * and above all no notice.
 */
describe('a Remove commit this device asked for is the first half of a re-admission', () => {
  it('does not retire and does not post the notice while a re-add is in flight', async () => {
    const conversations = new Map([['g1', convo('g1')]]);
    const addMessageToChat = vi.fn(async () => {});
    const d = { ...deps(async () => false, conversations), addMessageToChat, reAddInFlight: true };

    expect(await retireIfEvicted(d)).toBe(false);
    expect(conversations.get('g1')!.lifecycle).not.toBe('removed');
    expect(addMessageToChat).not.toHaveBeenCalled();
  });

  it('records that it is waiting, rather than leaving the row claiming a usable group', async () => {
    const conversations = new Map([['g1', convo('g1')]]);
    const d = { ...deps(async () => false, conversations), reAddInFlight: true };

    await retireIfEvicted(d);

    // `pending` is what unblocks the retry: `requestReAdd` returns early on `removed`, so writing
    // that during a re-admission stranded the group for good if the Welcome never arrived.
    expect(conversations.get('g1')!.lifecycle).toBe('pending');
    expect(d.saveConversation).toHaveBeenCalledWith('g1');
  });

  it('says in the log which of the two it decided, so the branch is never silent', async () => {
    const log = vi.fn();
    const conversations = new Map([['g1', convo('g1')]]);
    await retireIfEvicted({
      ...deps(async () => false, conversations, log),
      reAddInFlight: true,
    });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('re-admission'))).toBe(true);
    // The eviction wording must NOT appear: the campaign's watcher reads it as a real removal.
    expect(lines.some((l) => l.includes('Removed from'))).toBe(false);
  });

  it('still retires a removal this device never asked for', async () => {
    const conversations = new Map([['g1', convo('g1')]]);
    const d = { ...deps(async () => false, conversations), reAddInFlight: false };

    expect(await retireIfEvicted(d)).toBe(true);
    expect(conversations.get('g1')!.lifecycle).toBe('removed');
  });

  it('leaves a real exclusion already recorded alone, whatever is in flight', async () => {
    // A re-add in flight is not evidence against an eviction a different, authoritative path
    // already wrote down - it must not be walked back to `pending`.
    const conversations = new Map([['g1', convo('g1', 'removed')]]);
    const d = { ...deps(async () => false, conversations), reAddInFlight: true };

    expect(await retireIfEvicted(d)).toBe(false);
    expect(conversations.get('g1')!.lifecycle).toBe('removed');
  });
});

/**
 * THE OTHER HALF OF "NOTHING RETRACTS A NOTICE".
 *
 * Declining to write the notice covers the re-admission this device asked for. It does NOT cover a
 * removal somebody else decided followed by that same somebody adding us back: there the notice was
 * true when written and becomes a lie the moment the Welcome lands, and it is the one statement in
 * the thread the user cannot dismiss. The re-admission Welcome is the proof, so the withdrawal
 * happens against it and never on a timer.
 */
describe('retractEvictionNotice - a Welcome disproves the notice, so it is withdrawn', () => {
  const notice =
    'Vous avez été retiré de ce groupe. Vous ne pouvez plus envoyer ni recevoir de nouveaux messages.';

  function withMessages(msgs: unknown[]): Map<string, Conversation> {
    const c = convo('g1');
    return new Map([['g1', { ...c, messages: msgs } as unknown as Conversation]]);
  }

  it('removes the notice from the thread and from storage', async () => {
    const conversations = withMessages([
      { id: 'm1', isSystem: true, content: notice },
      { id: 'm2', isSystem: false, content: 'hello' },
    ]);
    const storage = { deleteMessage: vi.fn(async () => {}) };

    const n = await retractEvictionNotice({
      conversations,
      groupId: 'g1',
      storage,
      log: vi.fn(),
    });

    expect(n).toBe(1);
    expect(conversations.get('g1')!.messages.map((m) => m.id)).toEqual(['m2']);
    expect(storage.deleteMessage).toHaveBeenCalledWith('m1', 'g1');
  });

  it('leaves every other message alone, system ones included', async () => {
    const conversations = withMessages([
      { id: 'm1', isSystem: true, content: 'Quelqu un a rejoint le groupe' },
      { id: 'm2', isSystem: false, content: notice },
    ]);
    const storage = { deleteMessage: vi.fn(async () => {}) };

    // `m2` is NOT a system message: a peer quoting the sentence is not this device's own notice.
    expect(
      await retractEvictionNotice({ conversations, groupId: 'g1', storage, log: vi.fn() })
    ).toBe(0);
    expect(conversations.get('g1')!.messages).toHaveLength(2);
    expect(storage.deleteMessage).not.toHaveBeenCalled();
  });

  it('answers 0 on a thread that never carried one, which is the normal case', async () => {
    const conversations = withMessages([{ id: 'm1', isSystem: false, content: 'hi' }]);

    expect(await retractEvictionNotice({ conversations, groupId: 'g1', log: vi.fn() })).toBe(0);
  });

  it('withdraws from the thread even when storage refuses, and says so', async () => {
    // The user is looking at the thread. A storage write that fails must not leave the false
    // sentence on screen - and a swallowed branch logs.
    const conversations = withMessages([{ id: 'm1', isSystem: true, content: notice }]);
    const log = vi.fn();
    const storage = {
      deleteMessage: vi.fn(async () => {
        throw new Error('disk');
      }),
    };

    expect(await retractEvictionNotice({ conversations, groupId: 'g1', storage, log })).toBe(1);
    expect(conversations.get('g1')!.messages).toHaveLength(0);
    expect(log.mock.calls.some((c) => String(c[0]).includes('not from storage'))).toBe(true);
  });

  it('leaves a group it has no row for alone', async () => {
    const conversations = withMessages([{ id: 'm1', isSystem: true, content: notice }]);

    expect(await retractEvictionNotice({ conversations, groupId: 'other', log: vi.fn() })).toBe(0);
    expect(conversations.get('g1')!.messages).toHaveLength(1);
  });
});
