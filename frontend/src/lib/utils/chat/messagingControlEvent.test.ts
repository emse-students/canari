/**
 * A CONTROL EVENT THE QUEUE CANNOT TAKE IS LOGGED, NEVER THROWN (review of #1730).
 *
 * `enqueueOutboxMessage` rejects with `OutboxEnqueueError` when no controller is active (it used to
 * resolve silently). A reaction, edit, pin, delete or read watermark is best-effort, so the UI call
 * must resolve - and the loss must be accused in the log with the event's kind, not left as an
 * unhandled rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMessagePinned, addReaction } from './messaging';
import { unregisterOutbox } from './outbox';
import type { Conversation } from '$lib/types';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const deps = {
  mlsService: {} as never,
  userId: 'me',
  deviceKeyB64: 'k',
  conversation: {
    id: 'g1',
    name: 'alice',
    lifecycle: 'active',
    messages: [],
  } as unknown as Conversation,
};

afterEach(() => vi.restoreAllMocks());

describe('control events with no outbox controller', () => {
  it('a pin resolves and accuses the loss with its kind', async () => {
    unregisterOutbox();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(setMessagePinned('m1', true, 1, deps)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('control event "pin" not queued'));
  });

  it('a reaction resolves and accuses the loss with its kind', async () => {
    unregisterOutbox();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(addReaction('m1', '👍', 1, deps)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('control event "reaction" not queued')
    );
  });
});
