/**
 * A salon edit is honoured only from the message's author, for a plain text message, and in the
 * same way on a live frame, a history page and the sender's own write.
 *
 * The server cannot judge any of it - the row is an opaque blob - so these are the checks that stand
 * between a member and someone else's words.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage } from '$lib/types';
import { serializeEnvelope, mkTextEnvelope, mkPollEnvelope, parseEnvelope } from '$lib/envelope';
import { encodeAppMessage, decodeAppMessage, mkEdit } from '$lib/proto/codec';
import { applyChannelEdit, applyChannelEdits } from './channelEdit';

const text = (t: string) => serializeEnvelope(mkTextEnvelope(t));

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'row-1',
    senderId: 'alice',
    content: text('first'),
    timestamp: new Date(1_000),
    isOwn: false,
    ...over,
  };
}

const edit = (over: Record<string, unknown> = {}) => ({
  targetMessageId: 'row-1',
  senderId: 'alice',
  newContent: 'second',
  editedAt: 2_000,
  ...over,
});

const bodyOf = (m: ChatMessage) => {
  const env = parseEnvelope(m.content);
  return env.kind === 'text' ? env.text : '';
};

describe('applyChannelEdit', () => {
  it('lets the author replace the text and marks the row edited', () => {
    const { messages, applied } = applyChannelEdit([msg()], edit(), vi.fn());
    expect(applied).toBe(true);
    expect(bodyOf(messages[0])).toBe('second');
    expect(messages[0].isEdited).toBe(true);
    expect(messages[0].editedAt?.getTime()).toBe(2_000);
  });

  it('REFUSES an edit from another member, a moderator included, and says so', () => {
    const log = vi.fn();
    const before = [msg()];
    const { messages, applied } = applyChannelEdit(before, edit({ senderId: 'moderator' }), log);
    expect(applied).toBe(false);
    expect(messages).toBe(before);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REFUSED'));
  });

  it('refuses an empty replacement', () => {
    const log = vi.fn();
    expect(applyChannelEdit([msg()], edit({ newContent: '   ' }), log).applied).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it('keeps the free-format text, emoji included, through the frame and the apply', () => {
    const wire = decodeAppMessage(
      encodeAppMessage(mkEdit('row-1', 'Salut \u{1F600}\n**gras** éà', 2_000))
    );
    expect(wire?.edit?.messageId).toBe('row-1');
    expect(Number(wire?.edit?.editedAt)).toBe(2_000);
    const { messages } = applyChannelEdit(
      [msg()],
      edit({ newContent: wire?.edit?.newContent ?? '' }),
      vi.fn()
    );
    expect(bodyOf(messages[0])).toBe('Salut \u{1F600}\n**gras** éà');
  });

  it('never touches a poll, a notice, a deleted message or an absent one', () => {
    const poll = msg({
      content: serializeEnvelope(
        mkPollEnvelope(
          'q?',
          [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          false,
          null
        )
      ),
    });
    const log = vi.fn();
    expect(applyChannelEdit([poll], edit(), log).applied).toBe(false);
    expect(applyChannelEdit([msg({ isDeleted: true })], edit(), log).applied).toBe(false);
    expect(applyChannelEdit([msg({ isSystem: true })], edit(), log).applied).toBe(false);
    expect(applyChannelEdit([msg()], edit({ targetMessageId: 'ghost' }), log).applied).toBe(false);
  });

  it('keeps the reply reference the row already holds', () => {
    const quoted = msg({
      content: serializeEnvelope(
        mkTextEnvelope('first', { id: 'q', senderId: 'bob', content: 'quoted' })
      ),
    });
    const { messages } = applyChannelEdit([quoted], edit(), vi.fn());
    const env = parseEnvelope(messages[0].content);
    expect(env.kind === 'text' && env.replyTo?.id).toBe('q');
  });

  it('ends on one text whatever the order the two edits arrive in', () => {
    const early = edit({ newContent: 'early', editedAt: 2_000 });
    const late = edit({ newContent: 'late', editedAt: 3_000 });
    const inOrder = applyChannelEdits([msg()], [early, late], vi.fn());
    const reversed = applyChannelEdits([msg()], [late, early], vi.fn());
    expect(bodyOf(inOrder[0])).toBe('late');
    expect(bodyOf(reversed[0])).toBe('late');
  });

  it('takes the echo of its own edit as a quiet no-op', () => {
    const log = vi.fn();
    const once = applyChannelEdit([msg()], edit(), log).messages;
    const again = applyChannelEdit(once, edit(), log);
    expect(again.applied).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
