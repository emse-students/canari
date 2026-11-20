/**
 * A group created without a name tells the server none and stores none: every device draws it by
 * its members' first names (owner, 2026-11-17; docs/wiki/frontend/modules/chat.md#one-new-discussion-panel).
 */
import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

import { createNewGroup } from './groupCreation';
import type { Conversation } from '$lib/types';
import type { canari } from '$lib/proto/canari.js';
import { decodeAppMessage } from '$lib/proto/codec';
import { TransportFailureError } from '$lib/utils/transportFailure';

function deps(conversations = new SvelteMap<string, Conversation>()) {
  const local = new Set<string>();
  const mlsService = {
    createRemoteGroup: vi.fn(async (_name: string | null) => 'g-new'),
    registerMember: vi.fn(async () => {}),
    createGroup: vi.fn(async (id: string) => {
      local.add(id);
    }),
    fetchUserDevices: vi.fn(async () => []),
    getDeviceId: vi.fn(() => 'dev-1'),
    getLocalGroups: vi.fn(() => Array.from(local)),
    deleteGroupOnServer: vi.fn(async () => {}),
  };
  return {
    mlsService,
    conversations,
    args: {
      mlsService: mlsService as never,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.invalid',
      conversations,
      selectConversation: vi.fn(),
      saveConversation: vi.fn(async () => {}),
      log: vi.fn(),
    },
  };
}

describe('an unnamed group', () => {
  it('sends no name to the server and stores none', async () => {
    const d = deps();
    const outcome = await createNewGroup('   ', d.args);

    expect(outcome).toEqual({ ok: true, key: 'g-new' });
    expect(d.mlsService.createRemoteGroup).toHaveBeenCalledWith(null, true);
    expect(d.conversations.get('g-new')?.name).toBe('');
  });

  it('is never refused as a duplicate of another unnamed group', async () => {
    const d = deps();
    d.conversations.set('g-old', {
      id: 'g-old',
      name: '',
      contactName: '',
      conversationType: 'group',
    } as Conversation);
    const outcome = await createNewGroup('', d.args);
    expect(outcome.ok).toBe(true);
  });

  it('still refuses a NAMED group whose name is taken', async () => {
    const d = deps();
    d.conversations.set('g-old', {
      id: 'g-old',
      name: 'Equipe',
      contactName: 'Equipe',
      conversationType: 'group',
    } as Conversation);
    expect(await createNewGroup('equipe', d.args)).toEqual({
      ok: false,
      reason: 'duplicate-group-name',
    });
    expect(d.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });
});

/**
 * STEP 2 (sealed-names.md): a NAMED group dates its name at creation, by a silent `groupNamed`
 * statement in its first epoch - before anyone is invited, so every later member is handed it dated.
 */
describe('a named group dates its name at creation', () => {
  /** `deps()` with a send path: the frame it posted, and the server time it is answered with. */
  function withSend(answer: () => Promise<{ receivedAt: number | null }>) {
    const d = deps();
    const sent: Array<{ groupId: string; frame: canari.AppMessage | null }> = [];
    Object.assign(d.mlsService, {
      sendMessage: vi.fn(async (groupId: string, bytes: Uint8Array) => {
        sent.push({ groupId, frame: decodeAppMessage(bytes) });
        return answer();
      }),
    });
    return { ...d, sent };
  }

  it('sends ONE silent statement naming it, and dates the row by its answer at a statement rank', async () => {
    const at = Date.UTC(2026, 10, 20, 9, 0, 0);
    const d = withSend(async () => ({ receivedAt: at }));
    await createNewGroup('Les ROOTz', d.args);
    // Not awaited by the creation (#3888 review, S2): its outcome lands on the row when it comes.
    await vi.waitFor(() => expect(d.conversations.get('g-new')?.nameAt).toBe(at));
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].groupId).toBe('g-new');
    expect(d.sent[0].frame?.system?.event).toBe('groupNamed');
    expect(JSON.parse(d.sent[0].frame?.system?.data ?? '{}')).toEqual({ name: 'Les ROOTz' });
    expect(d.conversations.get('g-new')).toMatchObject({
      name: 'Les ROOTz',
      nameAt: at,
      nameFromStatement: true,
    });
    // Silent: no notice row anywhere, the creator's included.
    expect(d.conversations.get('g-new')?.messages).toEqual([]);
  });

  it('a statement with no answer leaves the group created, its statement recorded for the next connection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = withSend(async () => {
      throw new TransportFailureError(new Error('offline'));
    });
    expect(await createNewGroup('Les ROOTz', d.args)).toEqual({ ok: true, key: 'g-new' });
    await vi.waitFor(() => expect(d.conversations.get('g-new')?.nameSync?.statement).toBeDefined());
    const row = d.conversations.get('g-new')!;
    expect(row.nameAt).toBeUndefined();
    expect(row.nameSync?.statement).toMatchObject({ name: 'Les ROOTz' });
    vi.restoreAllMocks();
  });

  it('the creation returns without waiting for the statement round trip', async () => {
    const d = withSend(() => new Promise(() => {}));
    expect(await createNewGroup('Les ROOTz', d.args)).toEqual({ ok: true, key: 'g-new' });
    expect(d.conversations.get('g-new')?.nameAt).toBeUndefined();
  });

  it('an unnamed group states nothing', async () => {
    const d = withSend(async () => ({ receivedAt: 1 }));
    await createNewGroup('', d.args);
    expect(d.sent).toEqual([]);
  });
});
