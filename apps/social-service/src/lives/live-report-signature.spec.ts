/**
 * THE SERVER'S SIGNATURE ON A KEPT CHAT LINE (WP-L8b): what was recorded verifies, a row altered in
 * the database does not (its `keptAt` included), an erasure reads `erased` for the ONE id it
 * rewrote while the other account and the content keep their proof, an id rewritten to another
 * account is `altered` even beside an erasure, a rotated key reads `key-rotated`, and no key means
 * no signer at all (the caller refuses, never signs blank).
 */
import { createHash } from 'crypto';
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
  keptAt: new Date('2026-10-21T10:05:00.456Z'),
  text: 'une ligne signalée',
};
const accounts = {
  reportId: content.reportId,
  authorId: 'a'.repeat(64),
  reporterId: 'b'.repeat(64),
};
const ALL_VERIFIED = { content: 'verified', author: 'verified', reporter: 'verified' };

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

  it('names the key by an HMAC under it, never by a plain hash of the key', () => {
    const raw = 'k'.repeat(32);
    const { keyId } = withKey(raw);
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(keyId).not.toBe(createHash('sha256').update(raw).digest('hex').slice(0, 16));
    expect(withKey('n'.repeat(32)).keyId).not.toBe(keyId);
  });

  it('verifies what it signed', () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    expect(verifyReportedLine(key, stored, content, accounts, ERASED)).toEqual(ALL_VERIFIED);
  });

  it('reads an altered text, sequence or keptAt as altered content', () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    for (const changed of [
      { ...content, text: 'autre chose' },
      { ...content, seq: 8 },
      { ...content, keptAt: new Date('2026-12-01T00:00:00.000Z') },
    ]) {
      expect(verifyReportedLine(key, stored, changed, accounts, ERASED).content).toBe('altered');
    }
  });

  it('reads an author or a reporter rewritten to another account as altered, alone', () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    expect(
      verifyReportedLine(key, stored, content, { ...accounts, authorId: 'c'.repeat(64) }, ERASED)
    ).toEqual({ ...ALL_VERIFIED, author: 'altered' });
    expect(
      verifyReportedLine(key, stored, content, { ...accounts, reporterId: 'c'.repeat(64) }, ERASED)
    ).toEqual({ ...ALL_VERIFIED, reporter: 'altered' });
  });

  it("reads the author's or the reporter's erasure as erased for THAT id only", () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    expect(
      verifyReportedLine(key, stored, content, { ...accounts, authorId: ERASED }, ERASED)
    ).toEqual({ ...ALL_VERIFIED, author: 'erased' });
    expect(
      verifyReportedLine(key, stored, content, { ...accounts, reporterId: ERASED }, ERASED)
    ).toEqual({ ...ALL_VERIFIED, reporter: 'erased' });
  });

  it('never hides a re-attribution behind the other id being erased', () => {
    const key = withKey('k'.repeat(32));
    const stored = signReportedLine(key, content, accounts);
    expect(
      verifyReportedLine(
        key,
        stored,
        content,
        { ...accounts, reporterId: ERASED, authorId: 'c'.repeat(64) },
        ERASED
      )
    ).toEqual({ content: 'verified', author: 'altered', reporter: 'erased' });
  });

  it('reads a line signed under a previous key as key-rotated', () => {
    const stored = signReportedLine(withKey('k'.repeat(32)), content, accounts);
    expect(verifyReportedLine(withKey('n'.repeat(32)), stored, content, accounts, ERASED)).toEqual({
      content: 'key-rotated',
      author: 'key-rotated',
      reporter: 'key-rotated',
    });
  });

  it('reads every verdict as unverifiable when this estate has no key to check with', () => {
    const stored = signReportedLine(withKey('k'.repeat(32)), content, accounts);
    delete process.env.LIVE_REPORT_SIGNING_KEY;
    expect(verifyReportedLine(signingKey(), stored, content, accounts, ERASED)).toEqual({
      content: 'unverifiable',
      author: 'unverifiable',
      reporter: 'unverifiable',
    });
  });
});
