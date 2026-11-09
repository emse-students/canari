import { liveMentionRecipientsSql, parseChatMentions } from './live-mention';
import { LIVE_CHAT_MENTIONS_DECLARED_MAX, LIVE_CHAT_MENTIONS_MAX } from './live.constants';

const AUTHOR = 'a'.repeat(64);
const id = (c: string) => c.repeat(64);

/** The status and body of a thrown Nest exception. */
function refusal(f: () => unknown): { status: number; code?: string; field?: string } {
  try {
    f();
  } catch (e) {
    const err = e as { getStatus(): number; getResponse(): { code?: string; field?: string } };
    return { status: err.getStatus(), ...err.getResponse() };
  }
  throw new Error('did not throw');
}

describe('the mentions a live chat line declares (owner, 2026-11-09)', () => {
  it('none declared is none', () => {
    expect(parseChatMentions(undefined, AUTHOR)).toEqual([]);
    expect(parseChatMentions(null, AUTHOR)).toEqual([]);
    expect(parseChatMentions([], AUTHOR)).toEqual([]);
  });

  it('lower-cases, deduplicates, keeps the order and leaves the author out', () => {
    expect(
      parseChatMentions([id('B'), id('c'), id('b'), AUTHOR.toUpperCase(), id('d')], AUTHOR)
    ).toEqual([id('b'), id('c'), id('d')]);
  });

  it('keeps the first five and drops the rest', () => {
    const many = ['1', '2', '3', '4', '5', '6', '7'].map(id);
    expect(parseChatMentions(many, AUTHOR)).toEqual(many.slice(0, LIVE_CHAT_MENTIONS_MAX));
    expect(parseChatMentions(many, AUTHOR, 7)).toEqual(many);
  });

  it('refuses what is not a list of 64-hex ids, or is longer than a client may declare', () => {
    const bad = [
      'x',
      {},
      [1],
      ['not-an-id'],
      [id('g')],
      ['a'.repeat(63)],
      Array.from({ length: LIVE_CHAT_MENTIONS_DECLARED_MAX + 1 }, () => id('b')),
    ];
    for (const raw of bad) {
      expect(refusal(() => parseChatMentions(raw, AUTHOR))).toEqual({
        status: 400,
        code: 'LIVE_MESSAGE_INVALID',
        field: 'mentions',
      });
    }
  });
});

describe('the audience of a mention', () => {
  it('sends under the whole rule and the window, and suggests from the audience and the author alone', () => {
    const send = liveMentionRecipientsSql('send');
    const suggest = liveMentionRecipientsSql('suggest');
    expect(liveMentionRecipientsSql()).toBe(send);
    for (const sql of [send, suggest]) {
      expect(sql).toContain('b."blockerId" = $1');
      expect(sql).toContain('JOIN lives m_live');
    }
    expect(send).toContain('live_removed_viewers');
    expect(send).toContain('b2."blockerId" = m_live."broadcasterId"');
    expect(send).toContain('"mentionedUserIds"');
    expect(send).toContain('$4');
    // The suggestion is an oracle for ids the caller picks: no third party's removal or block.
    expect(suggest).not.toContain('live_removed_viewers');
    expect(suggest).not.toContain('b2.');
    expect(suggest).not.toContain('"mentionedUserIds"');
    expect(suggest).not.toContain('$4');
  });
});
