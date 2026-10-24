/**
 * THE LIVE CHAT SEAL (C12): a message opens only for the live, the clientId and the AUTHOR it was
 * sealed for, under the live key; anything else is a typed refusal the viewer drops. Real WebCrypto.
 */
import { describe, it, expect } from 'vitest';
import { LiveChatOpenError, openLiveChatMessage, sealLiveChatMessage } from './liveChatCrypto';
import { sealLiveSegment } from './liveCrypto';
import { fromBase64, toBase64 } from '$lib/utils/hex';

const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const LIVE = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const OTHER_LIVE = '1b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIENT = '44444444-4444-4444-8444-444444444444';
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

async function reason(p: Promise<unknown>): Promise<string> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(LiveChatOpenError);
  return (e as LiveChatOpenError).reason;
}

describe('the live chat seal', () => {
  it('opens to the same text, emoji and accents included', async () => {
    const text = 'Salut à tous 🐤 !';
    const sealed = await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, text);
    expect(await openLiveChatMessage(KEY, LIVE, CLIENT, ALICE, sealed)).toBe(text);
  });

  it('opens the known-answer line the SERVER opens too (social-service live-chat-seal.spec.ts)', async () => {
    // Sealed once with a fixed IV (00..0b) by Node's own AES-256-GCM. The server opens the same
    // bytes to check a reporter's plaintext (WP-L8b), so the two implementations of the v1 format
    // are pinned to each other, not each to itself.
    const kat = 'AAECAwQFBgcICQoLczpqKzo3pvhkWzb8CrrePTVHVWqR20J6Rbg3QWhWMe2XMPLR';
    expect(await openLiveChatMessage(KEY, LIVE, CLIENT, ALICE, kat)).toBe('Salut à tous 🐤 !');
  });

  it('is iv(12) + ciphertext + tag(16), within the server bound of 928 bytes at 300 chars', async () => {
    const sealed = fromBase64(await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, 'abc'));
    expect(sealed.byteLength).toBe(12 + 3 + 16);
    // 300 characters of three-byte UTF-8 is the worst case the composer lets through.
    const worst = fromBase64(await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, '€'.repeat(300)));
    expect(worst.byteLength).toBe(928);
  });

  it('draws a fresh IV on every seal, so a re-seal is never the same bytes', async () => {
    const a = await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, 'same');
    const b = await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, 'same');
    expect(a).not.toBe(b);
  });

  it('reads the ids in any case, as the server serves them lower case', async () => {
    const sealed = await sealLiveChatMessage(
      KEY,
      LIVE.toUpperCase(),
      CLIENT,
      ALICE.toUpperCase(),
      'x'
    );
    expect(await openLiveChatMessage(KEY, LIVE, CLIENT.toUpperCase(), ALICE, sealed)).toBe('x');
  });

  it.each([
    ['another author', KEY, LIVE, CLIENT, BOB],
    ['another live', KEY, OTHER_LIVE, CLIENT, ALICE],
    ['another clientId', KEY, LIVE, OTHER_CLIENT, ALICE],
    ['another key', OTHER_KEY, LIVE, CLIENT, ALICE],
  ])('refuses the message served under %s: unauthentic', async (_n, key, live, client, author) => {
    const sealed = await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, 'hello');
    expect(await reason(openLiveChatMessage(key, live, client, author, sealed))).toBe(
      'unauthentic'
    );
  });

  it('refuses a changed byte', async () => {
    const bytes = fromBase64(await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, 'hello'));
    bytes[14] ^= 1;
    expect(await reason(openLiveChatMessage(KEY, LIVE, CLIENT, ALICE, toBase64(bytes)))).toBe(
      'unauthentic'
    );
  });

  it('never opens a SEGMENT sealed under the same key as a message (distinct labels)', async () => {
    const segment = await sealLiveSegment(KEY, LIVE, 0, new Uint8Array([104, 105]));
    expect(await reason(openLiveChatMessage(KEY, LIVE, CLIENT, ALICE, toBase64(segment)))).toBe(
      'unauthentic'
    );
  });

  it('calls too short or not base64 malformed', async () => {
    expect(
      await reason(openLiveChatMessage(KEY, LIVE, CLIENT, ALICE, toBase64(new Uint8Array(27))))
    ).toBe('malformed');
    expect(await reason(openLiveChatMessage(KEY, LIVE, CLIENT, ALICE, '!!!not base64!!!'))).toBe(
      'malformed'
    );
  });

  it('refuses a bad argument as a programming error, before any crypto', async () => {
    await expect(sealLiveChatMessage('zz', LIVE, CLIENT, ALICE, 'x')).rejects.toBeInstanceOf(
      RangeError
    );
    await expect(sealLiveChatMessage(KEY, 'live', CLIENT, ALICE, 'x')).rejects.toBeInstanceOf(
      RangeError
    );
    await expect(sealLiveChatMessage(KEY, LIVE, 'c', ALICE, 'x')).rejects.toBeInstanceOf(
      RangeError
    );
    await expect(sealLiveChatMessage(KEY, LIVE, CLIENT, ' ', 'x')).rejects.toBeInstanceOf(
      RangeError
    );
  });
});

describe('the other direction (h)', () => {
  it('a chat message never opens as a SEGMENT under the same key', async () => {
    const { openLiveSegment, LiveSegmentOpenError } = await import('./liveCrypto');
    const message = fromBase64(await sealLiveChatMessage(KEY, LIVE, CLIENT, ALICE, 'hello there'));
    for (const index of [0, 1, 2]) {
      await expect(openLiveSegment(KEY, LIVE, index, message)).rejects.toBeInstanceOf(
        LiveSegmentOpenError
      );
    }
  });
});
