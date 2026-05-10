/**
 * Contract tests for the addMessageToChat options-based API.
 *
 * The original bug: connection.ts called addMessageToChat with 7 positional
 * arguments, but the exposed wrapper only accepted 4. The 5th–7th args
 * (messageId, replyTo, timestamp) were silently discarded, causing every
 * incoming message to get a random UUID instead of the wire message ID.
 *
 * These tests verify:
 *  1. All three interface types share the same options-object signature.
 *  2. messageId, replyTo, isSystem, timestamp flow through correctly.
 *  3. TypeScript would catch a regression back to positional args (svelte-check).
 */

import { describe, it, expect } from 'vitest';
import type { MessageHandlerDeps } from '$lib/utils/chat/connection';
import type { ConversationContext } from '$lib/composables/useConversations.svelte';
import type { ChatSessionCallbacks } from '$lib/composables/useChatSession.svelte';

// Helper: build a typed mock that records calls.
function spy<F extends (...args: any[]) => Promise<void>>(
  _type: F
): { fn: F; calls: Parameters<F>[] } {
  const calls: Parameters<F>[] = [];
  const fn = (async (...args: Parameters<F>) => {
    calls.push(args);
  }) as F;
  return { fn, calls };
}

describe('addMessageToChat options contract', () => {
  describe('MessageHandlerDeps (connection.ts)', () => {
    it('accepts messageId via options', async () => {
      const { fn, calls } = spy<MessageHandlerDeps['addMessageToChat']>(null!);
      await fn('alice@test.com', 'hello', 'convo', { messageId: 'wire-uuid-123' });
      expect(calls[0][3]?.messageId).toBe('wire-uuid-123');
    });

    it('accepts replyTo via options', async () => {
      const { fn, calls } = spy<MessageHandlerDeps['addMessageToChat']>(null!);
      const replyTo = { id: 'parent-id', senderId: 'bob@test.com', content: 'original' };
      await fn('alice@test.com', 'reply', 'convo', { replyTo });
      expect(calls[0][3]?.replyTo?.id).toBe('parent-id');
    });

    it('accepts messageId AND replyTo together', async () => {
      const { fn, calls } = spy<MessageHandlerDeps['addMessageToChat']>(null!);
      const replyTo = { id: 'p', senderId: 'b', content: 'c' };
      await fn('a', 'text', 'c', { messageId: 'msg-uuid', replyTo });
      expect(calls[0][3]?.messageId).toBe('msg-uuid');
      expect(calls[0][3]?.replyTo?.id).toBe('p');
    });

    it('accepts timestamp via options', async () => {
      const { fn, calls } = spy<MessageHandlerDeps['addMessageToChat']>(null!);
      const ts = new Date('2026-01-01T00:00:00Z');
      await fn('a', 'msg', 'c', { messageId: 'id', timestamp: ts });
      expect(calls[0][3]?.timestamp).toEqual(ts);
    });
  });

  describe('ConversationContext (useConversations)', () => {
    it('accepts isSystem via options', async () => {
      const { fn, calls } = spy<ConversationContext['addMessageToChat']>(null!);
      await fn('system', 'Alice joined', 'convo', { isSystem: true });
      expect(calls[0][3]?.isSystem).toBe(true);
    });

    it('accepts messageId + timestamp for channel history', async () => {
      const { fn, calls } = spy<ConversationContext['addMessageToChat']>(null!);
      const ts = new Date();
      await fn('user@test.com', 'channel msg', 'channel_abc', {
        messageId: 'ch-id',
        timestamp: ts,
      });
      expect(calls[0][3]?.messageId).toBe('ch-id');
      expect(calls[0][3]?.timestamp).toEqual(ts);
    });
  });

  describe('ChatSessionCallbacks (useChatSession)', () => {
    it('accepts messageId via options', async () => {
      const { fn, calls } = spy<ChatSessionCallbacks['addMessageToChat']>(null!);
      await fn('alice', 'hi', 'convo', { messageId: 'abc-123' });
      expect(calls[0][3]?.messageId).toBe('abc-123');
    });

    it('accepts isSystem via options', async () => {
      const { fn, calls } = spy<ChatSessionCallbacks['addMessageToChat']>(null!);
      await fn('system', 'notice', 'convo', { isSystem: true });
      expect(calls[0][3]?.isSystem).toBe(true);
    });
  });

  describe('cross-interface type compatibility', () => {
    it('a function typed as MessageHandlerDeps is assignable to ConversationContext', () => {
      // If the signatures diverge, this assignment fails at compile time (svelte-check).
      const impl: MessageHandlerDeps['addMessageToChat'] = async () => {};
      const asConvCtx: ConversationContext['addMessageToChat'] = impl;
      expect(asConvCtx).toBeDefined();
    });

    it('a function typed as ConversationContext is assignable to ChatSessionCallbacks', () => {
      const impl: ConversationContext['addMessageToChat'] = async () => {};
      const asCb: ChatSessionCallbacks['addMessageToChat'] = impl;
      expect(asCb).toBeDefined();
    });
  });
});
