/**
 * Contract tests for the addMessageToChat options-based API.
 *
 * The original bug: connection.ts called addMessageToChat with 7 positional
 * arguments, but the exposed wrapper only accepted 4. The 5th-7th args
 * (messageId, replyTo, timestamp) were silently discarded, causing every
 * incoming message to get a random UUID instead of the wire message ID.
 *
 * These tests verify:
 *  1. All three interface types share the same options-object signature.
 *  2. messageId, replyTo, isSystem, timestamp flow through correctly.
 *  3. TypeScript catches a regression back to positional args (svelte-check).
 */

import type { AddMessageToChatOptions } from '$lib/types';
import type { MessageHandlerDeps } from '$lib/utils/chat/connection';
import type { ConversationContext } from '$lib/composables/useConversations.svelte';
import type { ChatSessionCallbacks } from '$lib/composables/useChatSession.svelte';

type AddMsgFn = MessageHandlerDeps['addMessageToChat'];
type AddMsgOpts = AddMessageToChatOptions;

describe('addMessageToChat options contract', () => {
  describe('MessageHandlerDeps (connection.ts)', () => {
    it('accepts messageId via options', async () => {
      let captured: AddMsgOpts | undefined;
      const fn: AddMsgFn = async (_sid, _content, _name, options) => {
        captured = options;
      };
      await fn('alice@test.com', 'hello', 'convo', { messageId: 'wire-uuid-123' });
      expect(captured?.messageId).toBe('wire-uuid-123');
    });

    it('accepts replyTo via options', async () => {
      let captured: AddMsgOpts | undefined;
      const fn: AddMsgFn = async (_s, _c, _n, options) => {
        captured = options;
      };
      const replyTo = { id: 'parent-id', senderId: 'bob@test.com', content: 'original' };
      await fn('alice@test.com', 'reply', 'convo', { replyTo });
      expect(captured?.replyTo?.id).toBe('parent-id');
    });

    it('accepts messageId AND replyTo together', async () => {
      let captured: AddMsgOpts | undefined;
      const fn: AddMsgFn = async (_s, _c, _n, options) => {
        captured = options;
      };
      const replyTo = { id: 'p', senderId: 'b', content: 'c' };
      await fn('a', 'text', 'c', { messageId: 'msg-uuid', replyTo });
      expect(captured?.messageId).toBe('msg-uuid');
      expect(captured?.replyTo?.id).toBe('p');
    });

    it('accepts timestamp via options', async () => {
      let captured: AddMsgOpts | undefined;
      const fn: AddMsgFn = async (_s, _c, _n, options) => {
        captured = options;
      };
      const ts = new Date('2026-01-01T00:00:00Z');
      await fn('a', 'msg', 'c', { messageId: 'id', timestamp: ts });
      expect(captured?.timestamp).toEqual(ts);
    });
  });

  describe('ConversationContext (useConversations)', () => {
    type ConvFn = ConversationContext['addMessageToChat'];
    type ConvOpts = NonNullable<Parameters<ConvFn>[3]>;

    it('accepts isSystem via options', async () => {
      let captured: ConvOpts | undefined;
      const fn: ConvFn = async (_s, _c, _n, options) => {
        captured = options;
      };
      await fn('system', 'Alice joined', 'convo', { isSystem: true });
      expect(captured?.isSystem).toBe(true);
    });

    it('accepts messageId + timestamp for channel history', async () => {
      let captured: ConvOpts | undefined;
      const fn: ConvFn = async (_s, _c, _n, options) => {
        captured = options;
      };
      const ts = new Date('2026-03-01T12:00:00Z');
      await fn('user@test.com', 'channel msg', 'channel_abc', {
        messageId: 'ch-id',
        timestamp: ts,
      });
      expect(captured?.messageId).toBe('ch-id');
      expect(captured?.timestamp).toEqual(ts);
    });
  });

  describe('ChatSessionCallbacks (useChatSession)', () => {
    type CbFn = ChatSessionCallbacks['addMessageToChat'];
    type CbOpts = NonNullable<Parameters<CbFn>[3]>;

    it('accepts messageId via options', async () => {
      let captured: CbOpts | undefined;
      const fn: CbFn = async (_s, _c, _n, options) => {
        captured = options;
      };
      await fn('alice', 'hi', 'convo', { messageId: 'abc-123' });
      expect(captured?.messageId).toBe('abc-123');
    });

    it('accepts isSystem via options', async () => {
      let captured: CbOpts | undefined;
      const fn: CbFn = async (_s, _c, _n, options) => {
        captured = options;
      };
      await fn('system', 'notice', 'convo', { isSystem: true });
      expect(captured?.isSystem).toBe(true);
    });
  });

  describe('cross-interface type compatibility', () => {
    it('MessageHandlerDeps fn is assignable to ConversationContext', () => {
      // If signatures diverge, this fails at compile time (svelte-check catches it).
      const impl: MessageHandlerDeps['addMessageToChat'] = async () => {};
      const asConvCtx: ConversationContext['addMessageToChat'] = impl;
      expect(asConvCtx).toBeDefined();
    });

    it('ConversationContext fn is assignable to ChatSessionCallbacks', () => {
      const impl: ConversationContext['addMessageToChat'] = async () => {};
      const asCb: ChatSessionCallbacks['addMessageToChat'] = impl;
      expect(asCb).toBeDefined();
    });
  });
});
