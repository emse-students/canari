import { describe, expect, it } from 'vitest';
import { normalizePayerEmail } from './payerEmail';

describe('normalizePayerEmail', () => {
  it('trims and accepts an ordinary address', () => {
    expect(normalizePayerEmail('  a.b@example.com ')).toBe('a.b@example.com');
  });

  it.each(['', 'a', 'a@b', 'a b@c.fr', '@c.fr', 'a@@c.fr'])('refuses %j', (raw) => {
    expect(normalizePayerEmail(raw)).toBeNull();
  });
});
