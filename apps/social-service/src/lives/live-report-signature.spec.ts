/**
 * THE SERVER'S SIGNATURE ON A KEPT CHAT LINE (WP-L8b): what was recorded verifies, a row altered in
 * the database does not, an erasure reads `erased` without costing the content its proof, a rotated
 * key reads `key-rotated`, and no key means no signer at all (the caller refuses, never signs blank).
 */
import {
  LIVE_REPORT_SIGNING_KEY_MIN_LENGTH,
  signReportedLine,
  signingKey,
  verifyReportedLine,
} from './live-report-signature';

const ERASED = '[deleted]';
const content = {
  reportId: '11111111-1111-4111-8111-111111111111',
  liveId: '22222222-2222-4222-8222-222222222222',
  messageId: '33333333-3333-4333-8333-333333333333',
  seq: 7,
  clientId: '44444444-4444-4444-8444-444444444444',
  sealedSha256: 'f'.repeat(64),
  messageCreatedAt: new Date('2026-10-21T10:00:00.123Z'),
  text: 'une ligne signalée',
};
const accounts = {
  reportId: content.reportId,
  authorId: 'a'.repeat(64),
  reporterId: 'b'.repeat(64),
};

describe('the reported-line signature', () => {
  const before = process.env.LIVE_REPORT_SIGNING_KEY;
  afterEach(() => {
    if (before === undefined) delete process.env.LIVE_REPORT_SIGNING_KEY;
    else process.env.LIVE_REPORT_SIGNING_KEY = before;
  });
  const withKey = (k: string) => {
    process.env.LIVE_REPORT_SIGNING_KEY = k;
    return signingKey()!;
  };

  it('has no signer without a key of at least 32 characters', () => {
    delete process.env.LIVE_REPORT_SIGNING_KEY;
    expect(signingKey()).toBeNull();
    process.env.LIVE_REPORT_SIGNING_KEY = 'x'.repeat(LIVE_REPORT_SIGNING_KEY_MIN_LENGTH - 1);
    expect(signingKey()).toBeNull();
  });

  it('verifies what it signed', () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    expect(stored.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(verifyReportedLine(key, stored, content, accounts, ERASED)).toEqual({
      content: 'verified',
      accounts: 'verified',
    });
  });

  it('reads an altered text, sequence or author as altered', () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    expect(
      verifyReportedLine(key, stored, { ...content, text: 'autre chose' }, accounts, ERASED).content
    ).toBe('altered');
    expect(verifyReportedLine(key, stored, { ...content, seq: 8 }, accounts, ERASED).content).toBe(
      'altered'
    );
    expect(
      verifyReportedLine(key, stored, content, { ...accounts, authorId: 'c'.repeat(64) }, ERASED)
    ).toEqual({ content: 'verified', accounts: 'altered' });
  });

  it("reads the author's or the reporter's erasure as erased, the content still verified", () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    for (const erased of [
      { ...accounts, authorId: ERASED },
      { ...accounts, reporterId: ERASED },
    ]) {
      expect(verifyReportedLine(key, stored, content, erased, ERASED)).toEqual({
        content: 'verified',
        accounts: 'erased',
      });
    }
  });

  it('reads a line signed under a previous key as key-rotated', () => {
    const stored = signReportedLine(withKey('k'.repeat(32)), content, accounts);
    expect(verifyReportedLine(withKey('n'.repeat(32)), stored, content, accounts, ERASED)).toEqual({
      content: 'key-rotated',
      accounts: 'key-rotated',
    });
    delete process.env.LIVE_REPORT_SIGNING_KEY;
    expect(verifyReportedLine(signingKey(), stored, content, accounts, ERASED).content).toBe(
      'key-rotated'
    );
  });
});
