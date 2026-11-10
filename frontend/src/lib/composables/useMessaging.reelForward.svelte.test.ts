/**
 * A REEL MESSAGE IS NEVER FORWARDED - the rule lives in `forwardMessage`, the one entry point every
 * forward path (bubble menu, mobile actions) reaches, not in a hidden button.
 */
import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

await import('./useMessaging.svelte');

import type { Conversation } from '$lib/types';
import { mkMediaEnvelope, serializeEnvelope } from '$lib/envelope';

type MessagingContext = import('./useMessaging.svelte').MessagingContext;

const CHANNEL = 'channel_12cf41f3-0000-0000-0000-000000000000';
const DM = 'alice';

function media(intent?: 'reel-message') {
  return serializeEnvelope(
    mkMediaEnvelope(
      {
        mediaId: 'm1',
        key: '00'.repeat(32),
        iv: '00'.repeat(12),
        mimeType: 'video/mp4',
        size: 10,
        type: 'video',
        ...(intent ? { intent } : {}),
      } as never,
      ''
    )
  );
}

function ctxFor() {
  const conversations = new SvelteMap<string, Conversation>(
    [CHANNEL, DM].map((id) => [
      id,
      { id, name: id, messages: [], unreadCount: 0, lastMessageAt: 0 } as never,
    ])
  );
  const ensureMls = vi.fn();
  const ctx = {
    conversations,
    userId: 'me',
    log: vi.fn(),
    ensureMls,
  } as unknown as MessagingContext;
  return { ctx, ensureMls };
}

describe('forwardMessage refuses a reel message', () => {
  for (const target of [CHANNEL, DM]) {
    it(`to ${target === CHANNEL ? 'a salon' : 'a DM'}, before any transport is touched`, async () => {
      const { useMessaging } = await import('./useMessaging.svelte');
      const { ctx, ensureMls } = ctxFor();
      const result = await useMessaging().forwardMessage(media('reel-message'), target, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(ensureMls).not.toHaveBeenCalled();
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('[FORWARD] refused'));
    });
  }

  it('a forward whose leader tab died mid-send is drawn under its id and said "maybe sent"', async () => {
    // Fourth review of #3326: returning before the row invited a blind second forward.
    const { useMessaging } = await import('./useMessaging.svelte');
    const { DelegatedSendOutcomeUnknownError } = await import('$lib/mls-client/commitSubmission');
    const { m } = await import('$lib/paraglide/messages');
    const { ctx, ensureMls } = ctxFor();
    const dm = ctx.conversations.get(DM)!;
    ctx.conversations.set(DM, { ...dm, lifecycle: 'active' } as never);
    let sentId: string | undefined;
    ensureMls.mockReturnValue({
      sendMessage: vi.fn(async (groupId: string, _bytes: Uint8Array, id: string) => {
        sentId = id;
        throw new DelegatedSendOutcomeUnknownError(groupId);
      }),
    });

    const result = await useMessaging().forwardMessage(media(), DM, ctx);

    expect(result).toEqual({ success: false, error: m.chat_forward_maybe_sent() });
    expect(sentId).toBeDefined();
    expect(ctx.conversations.get(DM)!.messages.map((row) => row.id)).toContain(sentId);
  });

  it('a "maybe sent" forward whose row fails to draw is still "maybe sent", never a failure to retry', async () => {
    // Fifth review of #3326: the drawing's throw reached the generic "forward failed".
    const { useMessaging } = await import('./useMessaging.svelte');
    const { DelegatedSendOutcomeUnknownError } = await import('$lib/mls-client/commitSubmission');
    const { m } = await import('$lib/paraglide/messages');
    const { ctx, ensureMls } = ctxFor();
    const dm = ctx.conversations.get(DM)!;
    ctx.conversations.set(DM, { ...dm, lifecycle: 'active' } as never);
    ensureMls.mockReturnValue({
      sendMessage: vi.fn(async (groupId: string) => {
        // The conversation store breaks under the drawing.
        ctx.conversations.set = () => {
          throw new Error('draw failed');
        };
        throw new DelegatedSendOutcomeUnknownError(groupId);
      }),
    });

    const result = await useMessaging().forwardMessage(media(), DM, ctx);

    expect(result).toEqual({ success: false, error: m.chat_forward_maybe_sent() });
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('maybe-sent row'));
  });

  it('does not refuse an ordinary video (control): it proceeds to the transport', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx, ensureMls } = ctxFor();
    ensureMls.mockImplementation(() => {
      throw new Error('transport reached');
    });
    await expect(useMessaging().forwardMessage(media(), DM, ctx)).rejects.toThrow(
      'transport reached'
    );
    expect(ensureMls).toHaveBeenCalled();
  });
});
