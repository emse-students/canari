import { rowMentionsEveryone, vouchedEveryoneMention } from './channel.service';

/**
 * A salon's `@tous` is a moderator's (owner, 2026-11-25). The server vouches for the declaration or
 * not at all - see docs/wiki/services/chat-delivery.md, "@tous".
 */
describe('vouchedEveryoneMention', () => {
  it('vouches for a moderator who declared it', () => {
    expect(vouchedEveryoneMention({ mentionsEveryone: true }, true)).toBe('vouched');
  });

  it('does not vouch for a member - the text stays text', () => {
    expect(vouchedEveryoneMention({ mentionsEveryone: true }, false)).toBe('unvouched');
  });

  it('has nothing to vouch for when no call was declared', () => {
    expect(vouchedEveryoneMention({}, true)).toBe('absent');
    expect(vouchedEveryoneMention({ mentionsEveryone: false }, true)).toBe('absent');
  });

  it('ignores a call on a silent row, which rings nobody', () => {
    expect(vouchedEveryoneMention({ mentionsEveryone: true, silent: true }, true)).toBe('absent');
  });
});

describe('rowMentionsEveryone', () => {
  it('reads only the server-written flag', () => {
    expect(rowMentionsEveryone({ metadata: { mentionsEveryone: true } })).toBe(true);
    expect(rowMentionsEveryone({ metadata: {} })).toBe(false);
    expect(rowMentionsEveryone({ metadata: null as never })).toBe(false);
  });
});
