import { createHash } from 'node:crypto';
import { guestVisitorKey } from './guest-visitor';

describe('guestVisitorKey', () => {
  const saved = process.env.INTERNAL_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = saved;
  });

  it('is one key per form and address, and never the address', () => {
    process.env.INTERNAL_SECRET = 'secret-a';
    const key = guestVisitorKey('f1', '203.0.113.7');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(guestVisitorKey('f1', '203.0.113.7')).toBe(key);
    expect(guestVisitorKey('f2', '203.0.113.7')).not.toBe(key);
    expect(guestVisitorKey('f1', '203.0.113.8')).not.toBe(key);
    expect(key).not.toContain('203.0.113.7');
  });

  // Keyed: a plain hash of an address is reversed by hashing all 2^32 of them.
  it('depends on the secret, so the stored key is no plain hash of the address', () => {
    process.env.INTERNAL_SECRET = 'secret-a';
    const a = guestVisitorKey('f1', '203.0.113.7');
    process.env.INTERNAL_SECRET = 'secret-b';
    expect(guestVisitorKey('f1', '203.0.113.7')).not.toBe(a);
    for (const plain of [
      '203.0.113.7',
      'f1:203.0.113.7',
      'canari:guest-visitor:v1:f1:203.0.113.7',
    ]) {
      expect(a).not.toBe(createHash('sha256').update(plain).digest('hex'));
    }
  });

  // Control (2026-10-22): the empty-secret refusal removed -> an HMAC under '' was answered, and
  // this test failed.
  it('refuses to derive a key with no secret, rather than fall back to an unkeyed one', () => {
    delete process.env.INTERNAL_SECRET;
    expect(() => guestVisitorKey('f1', '203.0.113.7')).toThrow('INTERNAL_SECRET is unset');
    process.env.INTERNAL_SECRET = '';
    expect(() => guestVisitorKey('f1', '203.0.113.7')).toThrow('INTERNAL_SECRET is unset');
  });
});
