/**
 * THE SERVER'S OPENING OF A SEALED CHAT LINE (WP-L8b), pinned to the CLIENT's v1 format by a
 * known-answer vector the frontend's `liveChatCrypto.test.ts` opens too: the same bytes, the same
 * text, on both sides. Then every binding of the AAD refuses a line moved elsewhere.
 */
import { openLiveChatLine } from './live-chat-seal';

const KEY = 'ab'.repeat(32);
const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const ALICE = 'a'.repeat(64);
/** iv 00..0b, 'Salut à tous 🐤 !' - identical in `frontend/src/lib/live/liveChatCrypto.test.ts`. */
const KAT = Buffer.from(
  'AAECAwQFBgcICQoLczpqKzo3pvhkWzb8CrrePTVHVWqR20J6Rbg3QWhWMe2XMPLR',
  'base64'
);

describe('openLiveChatLine', () => {
  it('opens the shared known-answer line to its text, accents and emoji included', () => {
    expect(openLiveChatLine(KEY, LIVE, CLIENT, ALICE, KAT)).toBe('Salut à tous 🐤 !');
    // Ids in any case, as the URL or the row may spell them.
    expect(openLiveChatLine(KEY, LIVE.toUpperCase(), CLIENT, ALICE.toUpperCase(), KAT)).toBe(
      'Salut à tous 🐤 !'
    );
  });

  it.each([
    ['another key', 'cd'.repeat(32), LIVE, CLIENT, ALICE],
    ['another live', KEY, '1b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b', CLIENT, ALICE],
    ['another clientId', KEY, LIVE, '44444444-4444-4444-8444-444444444444', ALICE],
    ['another author', KEY, LIVE, CLIENT, 'b'.repeat(64)],
  ])('refuses the line under %s', (_label, key, live, client, author) => {
    expect(openLiveChatLine(key, live, client, author, KAT)).toBeNull();
  });

  it('refuses a changed byte and a line too short to hold an IV and a tag', () => {
    const changed = Buffer.from(KAT);
    changed[14] ^= 1;
    expect(openLiveChatLine(KEY, LIVE, CLIENT, ALICE, changed)).toBeNull();
    expect(openLiveChatLine(KEY, LIVE, CLIENT, ALICE, KAT.subarray(0, 27))).toBeNull();
  });
});
