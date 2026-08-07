import {
  DESYNC_RETRANSMIT_WINDOW_MS,
  noteSentFrame,
  recentSentSince,
  forgetRecentSends,
  resetRecentSendsForTests,
} from './recentSends';

const proto = (n: number) => new Uint8Array([n]);

beforeEach(() => resetRecentSendsForTests());

describe('what the sender keeps so it can send it again', () => {
  it('returns the payloads sent at or after the window start, oldest first', () => {
    const now = Date.now();
    noteSentFrame('g1', 'm1', proto(1), now - 90_000);
    noteSentFrame('g1', 'm2', proto(2), now - 30_000);
    noteSentFrame('g1', 'm3', proto(3), now - 1_000);

    const got = recentSentSince('g1', now - 60_000);

    expect(got.map((s) => s.messageId)).toEqual(['m2', 'm3']);
    expect(Array.from(got[0].proto)).toEqual([2]);
  });

  it('keeps conversations apart', () => {
    const now = Date.now();
    noteSentFrame('g1', 'm1', proto(1), now);
    noteSentFrame('g2', 'm2', proto(2), now);

    expect(recentSentSince('g1', now - 1_000).map((s) => s.messageId)).toEqual(['m1']);
    expect(recentSentSince('g2', now - 1_000).map((s) => s.messageId)).toEqual(['m2']);
  });

  it('stores one entry per messageId, so a retry does not queue two copies', () => {
    const now = Date.now();
    noteSentFrame('g1', 'm1', proto(1), now - 2_000);
    noteSentFrame('g1', 'm1', proto(9), now - 1_000);

    const got = recentSentSince('g1', now - 60_000);
    expect(got).toHaveLength(1);
    expect(Array.from(got[0].proto)).toEqual([9]);
  });

  it('drops payloads older than the retention window even if the caller asks for more', () => {
    const now = Date.now();
    noteSentFrame('g1', 'old', proto(1), now - 10 * 60_000);
    noteSentFrame('g1', 'new', proto(2), now);

    // A window wider than what is retained must not silently return a shorter answer as if it were
    // complete - it returns what exists, and the caller reports the count it actually resent.
    expect(recentSentSince('g1', 0).map((s) => s.messageId)).toEqual(['new']);
  });

  it('retains everything the widest question a peer can ask about could name', () => {
    const now = Date.now();
    // A frame sent at the very edge of the advertised window, whose signal then takes a moment to
    // reach us: retaining exactly the window would drop precisely what every request asks about.
    noteSentFrame('g1', 'edge', proto(1), now - DESYNC_RETRANSMIT_WINDOW_MS);
    expect(
      recentSentSince('g1', now - DESYNC_RETRANSMIT_WINDOW_MS).map((s) => s.messageId)
    ).toEqual(['edge']);
  });

  it('stops retaining once no peer could still be asking - the window plus a round trip', () => {
    const now = Date.now();
    noteSentFrame('g1', 'unaskable', proto(1), now - DESYNC_RETRANSMIT_WINDOW_MS - 31_000);
    noteSentFrame('g1', 'askable', proto(2), now - DESYNC_RETRANSMIT_WINDOW_MS - 29_000);
    expect(recentSentSince('g1', 0).map((s) => s.messageId)).toEqual(['askable']);
  });

  it('caps how much it retains per conversation', () => {
    const now = Date.now();
    for (let i = 0; i < 40; i++) noteSentFrame('g1', `m${i}`, proto(i), now - (40 - i) * 100);

    const got = recentSentSince('g1', 0);
    expect(got).toHaveLength(25);
    expect(got[0].messageId).toBe('m15');
  });

  it('drops a conversation on request', () => {
    noteSentFrame('g1', 'm1', proto(1));
    forgetRecentSends('g1');
    expect(recentSentSince('g1', 0)).toEqual([]);
  });
});
