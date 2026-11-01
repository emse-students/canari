import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: async () => (id: string) => `name-of-${id}`,
}));
vi.mock('$lib/notifications/preferencesApi', () => ({
  fetchNotificationPreferences: vi.fn(),
  saveDisabledCategories: vi.fn(),
  saveGroupNotificationLevel: vi.fn().mockResolvedValue(undefined),
  saveGroupCallsAllowed: vi.fn().mockResolvedValue(undefined),
  fetchChannelNotificationLevel: vi.fn(),
}));

const server = vi.hoisted(() => ({
  mode: 'audio' as 'off' | 'audio',
  answered: true,
  refresh: async (): Promise<void> => {},
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverCallsMode: () => server.mode,
  getAppVersionCheck: () => (server.answered ? {} : null),
  refreshAppVersionCheck: () => server.refresh(),
}));

import {
  handleCallSignalForChat,
  setCallSystemMessageContext,
  type CallSystemMessageContext,
} from './callSystemMessages';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import { parseEnvelope } from '$lib/envelope';
import type { Conversation } from '$lib/types';

/** When the call event happened, as its frame dates it (`receivedNoticeTime`). */
const AT = { timestamp: new Date(1_700_000_000_000), serverTimestamp: 1_700_000_000_040 };

const G = '0b9f3d7e-1111-4222-8333-444455556666';

function makeCtx() {
  const addMessageToChat = vi.fn(async () => {});
  const conversations = new SvelteMap<string, Conversation>([
    [G, { id: G, messages: [] } as unknown as Conversation],
  ]);
  const ctx: CallSystemMessageContext = {
    userId: 'me',
    deviceKey: () => 'dk',
    storage: null,
    conversations,
    addMessageToChat,
  };
  return { ctx, addMessageToChat };
}

const invite = { callId: 'call-1', offerSdp: 'START' };

describe('handleCallSignalForChat - the conversation call permission', () => {
  beforeEach(() => {
    notificationPreferences.reset();
    // The record writer is idempotent per callId for the life of its context: each test is a new one.
    setCallSystemMessageContext(null);
  });

  it('writes the call as started where calls may ring', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, invite, 'me', AT);
    const [, content] = addMessageToChat.mock.calls[0] as unknown as [string, string];
    const env = parseEnvelope(content);
    expect(env.kind === 'system' && env.callEvent?.endedAt).toBeFalsy();
  });

  it('writes it as MISSED when the server answers off, after waiting for the answer', async () => {
    server.mode = 'off';
    server.answered = false;
    server.refresh = async () => {
      server.answered = true;
    };
    try {
      const { ctx, addMessageToChat } = makeCtx();
      await handleCallSignalForChat(ctx, 'caller', G, invite, 'me', AT);
      expect(addMessageToChat).toHaveBeenCalledTimes(1);
      const [, content] = addMessageToChat.mock.calls[0] as unknown as [string, string];
      const env = parseEnvelope(content);
      expect(env.kind === 'system' && env.callEvent?.endedAt).toBeTruthy();
    } finally {
      server.mode = 'audio';
      server.answered = true;
      server.refresh = async () => {};
    }
  });

  it('writes it as MISSED at once where calls are not allowed, instead of a ring', async () => {
    await notificationPreferences.setGroupCallsAllowed(G, false);
    const { ctx, addMessageToChat } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, invite, 'me', AT);
    expect(addMessageToChat).toHaveBeenCalledTimes(1);
    const [, content, groupId, options] = addMessageToChat.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { messageId: string },
    ];
    expect(groupId).toBe(G);
    expect(options.messageId).toBe('call-call-1');
    const env = parseEnvelope(content);
    // Missed is final: a later hangup from the caller leaves it as it is.
    expect(env.kind === 'system' && env.callEvent?.endedAt).toBeTruthy();
  });

  it('follows a conversation set to none when the account never chose', async () => {
    await notificationPreferences.setGroupLevel(G, 'none');
    const { ctx, addMessageToChat } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, invite, 'me', AT);
    const [, content] = addMessageToChat.mock.calls[0] as unknown as [string, string];
    const env = parseEnvelope(content);
    expect(env.kind === 'system' && env.callEvent?.endedAt).toBeTruthy();
  });
});
