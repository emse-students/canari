import { describe, it, expect, vi } from 'vitest';
import { readLocalMembership, retireIfEvicted } from './eviction';
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
    userId: 'u1',
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
      userId: 'u1',
      saveConversation: vi.fn(async () => {}),
      log,
    });

    expect(log.mock.calls.flat().join(' ')).toContain('could not be read after a commit');
  });
});
