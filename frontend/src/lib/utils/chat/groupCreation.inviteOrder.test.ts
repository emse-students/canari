import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: {
    isMessageCatchupActive: false,
    resetMessageCatchupState: vi.fn(),
  },
}));

vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { inviteMembersToGroup } from './groupCreation';

/**
 * The INVITE path owes the same ordering as creation: the server names a joiner BEFORE its Welcome
 * can arrive. Registering after delivery left an inviter dying between the two with a member in
 * the MLS tree that the delivery service did not know (backlog, measured 2026-09-05).
 */
function inviteDeps(registerImpl?: (u: string) => Promise<void>) {
  const order: string[] = [];
  const mlsService = {
    registerMember: vi.fn(async (_g: string, u: string) => {
      order.push(`register:${u}`);
      if (registerImpl) await registerImpl(u);
    }),
    fetchUserDevices: vi.fn(async (u: string) => [{ deviceId: `${u}-dev` }]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    addMembersBulk: vi.fn(async () => ({
      addedDeviceIds: ['bob-dev', 'carol-dev'],
      skipped: [],
      welcome: new Uint8Array([1]),
    })),
    sendWelcome: vi.fn(async (_w: unknown, owner: string) => {
      order.push(`welcome:${owner}`);
    }),
    sendMessage: vi.fn(async () => {}),
    getDeviceId: vi.fn(() => 'dev-1'),
  };
  return {
    order,
    mlsService,
    deps: {
      mlsService: mlsService as never,
      storage: null,
      userId: 'u1',
      deviceKeyB64: 'k',
      historyBaseUrl: 'https://example.invalid',
      conversations: new SvelteMap(),
      selectConversation: vi.fn(),
      saveConversation: vi.fn(async () => {}),
      log: vi.fn(),
    },
  };
}

const convo = { id: 'g1' } as never;

describe('inviteMembersToGroup - register before deliver', () => {
  it('registers every joiner before any Welcome is sent', async () => {
    const d = inviteDeps();
    await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    const firstWelcome = d.order.findIndex((s) => s.startsWith('welcome:'));
    const lastRegister = d.order.map((s) => s.startsWith('register:')).lastIndexOf(true);
    expect(firstWelcome).toBeGreaterThan(-1);
    expect(lastRegister).toBeLessThan(firstWelcome);
  });

  it('withholds the Welcome from a user whose registration failed', async () => {
    const d = inviteDeps(async (u) => {
      if (u === 'carol') throw new Error('down');
    });
    await inviteMembersToGroup(['bob', 'carol'], convo, d.deps as never);

    expect(d.order).toContain('welcome:bob');
    expect(d.order).not.toContain('welcome:carol');
  });
});
