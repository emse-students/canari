// @vitest-environment happy-dom
/**
 * A SALON EDIT OR REACTION MADE OFFLINE STAYS ON SCREEN AND GOES ON THE RECONNECT (WP-OFF-4).
 *
 * Before it, an edit was applied only after its POST succeeded - offline, the text the author had
 * just corrected snapped back with an error - and a reaction was rolled back on any transport
 * failure. Both now apply at once, are OWED to the reconnect when the link is down (`salonOwed.ts`),
 * and go again under the SAME row id, which the server answers with the row it holds (migration 090).
 * They are taken back only when nothing of them left the device - a refusal, never a lost answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { SvelteMap } from 'svelte/reactivity';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { getChannelReactions } from '$lib/stores/reactionStore.svelte';
import { activeReactions } from '$lib/utils/chat/messageReactions';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { ChannelApiError } from '$lib/services/ChannelService';
import { serializeEnvelope, mkTextEnvelope, envelopeBodyText } from '$lib/envelope';
import { resetOwedSalonWrites } from '$lib/utils/chat/salonOwed';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';

vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

const sendChannelReaction = vi.fn();
const sendChannelEdit = vi.fn();
vi.mock('$lib/utils/chat/channelCrypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/channelCrypto')>()),
  sendChannelReaction: (...args: unknown[]) => sendChannelReaction(...args),
  sendChannelEdit: (...args: unknown[]) => sendChannelEdit(...args),
}));

vi.mock('$lib/utils/chat/reactionNotify', () => ({
  notifyReaction: vi.fn().mockResolvedValue(undefined),
}));

import { useChannelWorkspaces, type ChannelWorkspaceContext } from './useChannelWorkspaces.svelte';

const SALON = 'channel_5e6f7a8b-0000-4000-8000-000000000001';

function makeContext(): ChannelWorkspaceContext {
  const conversations = new SvelteMap<string, any>([
    [
      SALON,
      {
        id: SALON,
        name: SALON,
        messages: [
          {
            id: 'srv-mine',
            senderId: 'u1',
            content: serializeEnvelope(mkTextEnvelope('first draft')),
            timestamp: new Date(1_000),
            isOwn: true,
          },
        ],
      },
    ],
  ]);
  return {
    conversations,
    saveConversation: vi.fn().mockResolvedValue(undefined),
    selectConversation: vi.fn(),
    getSelectedConversationId: () => null,
    reloadChannelHistory: vi.fn().mockResolvedValue(undefined),
    invalidateChannelHistoryCache: vi.fn(),
    log: vi.fn(),
  } as unknown as ChannelWorkspaceContext;
}

const body = (ctx: ChannelWorkspaceContext) =>
  envelopeBodyText(ctx.conversations.get(SALON)!.messages[0].content);
/**
 * Moves the clock one millisecond on. Two gestures made in one millisecond carry one instant, and the
 * later one must be LATER (an edit's `editedAt`, a reaction's timestamp decide which wins) - so the
 * clock is faked and stepped, never waited on: only `Date` is faked, `vi.waitFor` keeps real timers.
 */
function laterInstant(): void {
  vi.setSystemTime(Date.now() + 1);
}
const mine = (messageId: string) =>
  activeReactions(getChannelReactions(messageId)).filter((r) => r.userId === 'u1');

beforeEach(() => {
  vi.clearAllMocks();
  sendChannelReaction.mockReset();
  sendChannelEdit.mockReset();
  connectivity.reset();
  resetOwedSalonWrites();
  setCurrentUserId('u1');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_700_000_000_000);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  connectivity.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a salon edit', () => {
  it('is shown at once, owed while offline, and sent on the reconnect under one row id', async () => {
    connectivity.notifyServerUnreachable();
    sendChannelEdit.mockResolvedValue(undefined);
    const ctx = makeContext();

    await useChannelWorkspaces().editChannelMessage(SALON, 'srv-mine', 'fixed offline', ctx);

    // On screen at once - it used to wait for the POST and, offline, never came.
    expect(body(ctx)).toBe('fixed offline');
    expect(ctx.conversations.get(SALON)!.messages[0].isEdited).toBe(true);
    expect(sendChannelEdit).not.toHaveBeenCalled();

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(sendChannelEdit).toHaveBeenCalledTimes(1));
    const [, target, text, editedAt, rowId] = sendChannelEdit.mock.calls[0];
    expect([target, text]).toEqual(['srv-mine', 'fixed offline']);
    expect(editedAt).toBe(ctx.conversations.get(SALON)!.messages[0].editedAt!.getTime());
    expect(typeof rowId).toBe('string');
    expect(body(ctx)).toBe('fixed offline');
  });

  it('a second edit made offline owes ITSELF, and only it goes', async () => {
    connectivity.notifyServerUnreachable();
    sendChannelEdit.mockResolvedValue(undefined);
    const ctx = makeContext();
    const api = useChannelWorkspaces();

    await api.editChannelMessage(SALON, 'srv-mine', 'one', ctx);
    laterInstant();
    await api.editChannelMessage(SALON, 'srv-mine', 'two', ctx);
    connectivity.notifyServerReachable();

    await vi.waitFor(() => expect(sendChannelEdit).toHaveBeenCalledTimes(1));
    expect(sendChannelEdit.mock.calls[0][2]).toBe('two');
  });

  it('is taken back when the server refused it (nothing left the device)', async () => {
    sendChannelEdit.mockRejectedValue(new ChannelApiError(403, null, 'no'));
    const ctx = makeContext();

    await useChannelWorkspaces().editChannelMessage(SALON, 'srv-mine', 'refused', ctx);

    expect(body(ctx)).toBe('first draft');
    expect(ctx.conversations.get(SALON)!.messages[0].isEdited).toBeFalsy();
  });

  it('stays when the failure may have stored it (a 5xx)', async () => {
    sendChannelEdit.mockRejectedValue(new ChannelApiError(502, null, 'gateway'));
    const ctx = makeContext();

    await useChannelWorkspaces().editChannelMessage(SALON, 'srv-mine', 'maybe stored', ctx);

    expect(body(ctx)).toBe('maybe stored');
  });

  it('stays when no answer came with the link up: the outcome is unknown', async () => {
    sendChannelEdit.mockRejectedValue(new TransportFailureError(new TypeError('Failed to fetch')));
    const ctx = makeContext();

    await useChannelWorkspaces().editChannelMessage(SALON, 'srv-mine', 'answer lost', ctx);

    expect(connectivity.isOffline).toBe(false);
    expect(body(ctx)).toBe('answer lost');
  });
});

describe('a salon reaction', () => {
  it('keeps its pill offline and goes once on the reconnect, with its own row id and clock', async () => {
    connectivity.notifyServerUnreachable();
    sendChannelReaction.mockResolvedValue(undefined);
    const ctx = makeContext();

    await useChannelWorkspaces().toggleChannelReaction(SALON, 'm-offline-1', '👍', ctx);

    // It used to be rolled back with a network error the moment the POST failed.
    expect(mine('m-offline-1')).toHaveLength(1);
    expect(sendChannelReaction).not.toHaveBeenCalled();

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(sendChannelReaction).toHaveBeenCalledTimes(1));
    const [, target, emoji, at, removed, rowId] = sendChannelReaction.mock.calls[0];
    expect([target, emoji, removed]).toEqual(['m-offline-1', '👍', false]);
    expect(typeof at).toBe('number');
    expect(typeof rowId).toBe('string');
    expect(mine('m-offline-1')).toHaveLength(1);
  });

  it('a POST that meets the link going down is owed, and its repeat is the SAME row', async () => {
    sendChannelReaction.mockImplementationOnce(() => {
      connectivity.notifyServerUnreachable();
      return Promise.reject(new TransportFailureError(new TypeError('Failed to fetch')));
    });
    const ctx = makeContext();

    await useChannelWorkspaces().toggleChannelReaction(SALON, 'm-offline-2', '🔥', ctx);
    expect(mine('m-offline-2')).toHaveLength(1);

    sendChannelReaction.mockResolvedValueOnce(undefined);
    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(sendChannelReaction).toHaveBeenCalledTimes(2));
    const [first, repeat] = sendChannelReaction.mock.calls;
    // Same `at` and row id: if the first POST had landed, the server answers this one with it.
    expect(repeat[3]).toBe(first[3]);
    expect(repeat[5]).toBe(first[5]);
  });

  it('keeps its pill when its answer is lost with the link up - the peers may hold it', async () => {
    sendChannelReaction.mockRejectedValue(
      new RequestDeadlineError('api' as never, 1, 'POST', '/x', 0)
    );
    const ctx = makeContext();

    await useChannelWorkspaces().toggleChannelReaction(SALON, 'm-lost-1', '🎉', ctx);

    // Rolled back here, at a LATER instant, it would beat this device's own frame for good.
    expect(mine('m-lost-1')).toHaveLength(1);
  });

  it('is rolled back when the server refused it', async () => {
    sendChannelReaction.mockRejectedValue(new ChannelApiError(403, null, 'no'));
    const ctx = makeContext();

    await useChannelWorkspaces().toggleChannelReaction(SALON, 'm-refused-1', '🎉', ctx);

    expect(mine('m-refused-1')).toHaveLength(0);
  });

  it('placed then taken back offline owes the removal alone', async () => {
    connectivity.notifyServerUnreachable();
    sendChannelReaction.mockResolvedValue(undefined);
    const ctx = makeContext();
    const api = useChannelWorkspaces();

    await api.toggleChannelReaction(SALON, 'm-offline-3', '😂', ctx);
    laterInstant();
    await api.toggleChannelReaction(SALON, 'm-offline-3', '😂', ctx);
    expect(mine('m-offline-3')).toHaveLength(0);

    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(sendChannelReaction).toHaveBeenCalledTimes(1));
    expect(sendChannelReaction.mock.calls[0][4]).toBe(true);
  });
});
