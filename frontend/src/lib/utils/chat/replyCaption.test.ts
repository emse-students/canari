import { describe, it, expect } from 'vitest';
import { replyCaption, type ReplyCaptionInput } from './replyCaption';

const base: ReplyCaptionInput = {
  headerShown: false,
  isOwn: false,
  replierId: 'alice',
  quotedId: 'bob',
  currentUserId: 'me',
  replierName: 'Alice',
  quotedName: 'Bob',
};
const cap = (o: Partial<ReplyCaptionInput>) => replyCaption({ ...base, ...o });

describe('replyCaption', () => {
  it('header shown, another author quoted: names only the quoted author', () => {
    expect(cap({ headerShown: true })).toBe('A répondu à Bob');
  });

  it('header shown, self-reply: "son message", never the name again', () => {
    const out = cap({ headerShown: true, quotedId: 'alice', quotedName: 'Alice' });
    expect(out).toBe('A répondu à son message');
    expect(out).not.toContain('Alice');
  });

  it('header shown, the reader quoted: "Vous a répondu"', () => {
    expect(cap({ headerShown: true, quotedId: 'me' })).toBe('Vous a répondu');
  });

  it('no header: stays self-contained and names both', () => {
    expect(cap({})).toBe('Alice a répondu à Bob');
    expect(cap({ quotedId: 'alice' })).toBe('Alice a répondu à son message');
    expect(cap({ quotedId: 'me' })).toBe('Alice vous a répondu');
  });

  it('own message: "vous", quoted author named', () => {
    expect(cap({ isOwn: true, replierId: 'me' })).toBe('Vous avez répondu à Bob');
    expect(cap({ isOwn: true, replierId: 'me', quotedId: 'me' })).toBe(
      'Vous avez répondu à votre message'
    );
  });
});
