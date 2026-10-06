/**
 * A REPLY BELONGS TO ONE CONVERSATION. It used to be a single `replyingTo` on the composable, so a
 * reply armed in a DM stayed above the composer of whatever conversation was opened next (Mi 9T,
 * 2026-10-06). It is now keyed by conversation id: each composer reads its own entry.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const { useMessaging } = await import('./useMessaging.svelte');

const msg = (id: string) => ({ id, content: id, senderId: 'a' }) as never;

describe('the reply context is scoped to one conversation', () => {
  it('does not follow the member into another conversation', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const messaging = useMessaging();
    messaging.handleReply('dm-1', msg('m1'));

    expect(messaging.replyFor('dm-1')?.id).toBe('m1');
    expect(messaging.replyFor('salon-2')).toBeNull();
  });

  it('keeps one reply per conversation and cancels only the named one', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const messaging = useMessaging();
    messaging.handleReply('dm-1', msg('m1'));
    messaging.handleReply('salon-2', msg('m2'));
    messaging.cancelReply('dm-1');

    expect(messaging.replyFor('dm-1')).toBeNull();
    expect(messaging.replyFor('salon-2')?.id).toBe('m2');
  });

  it('ignores a reply armed with no conversation open', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const messaging = useMessaging();
    messaging.handleReply('', msg('m1'));

    expect(messaging.replyFor('')).toBeNull();
    expect(messaging.replyFor(null)).toBeNull();
  });
});
