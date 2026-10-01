/**
 * The whole-blob seam reads BOTH formats, and the REF decides which - never the bytes.
 *
 * Every surface but a streamed video goes through `acquireDecryptedMediaBlobUrl`: a picture, a
 * download, the lightbox, a chat bubble. So this is where "legacy blobs stay readable for ever" and
 * "a segmented blob is readable from the reader release on" are both true or neither is.
 */
import { vi } from 'vitest';
import { encryptMediaBuffer } from '$lib/mediaCrypto';
import { encryptSegmentedMedia, SegmentedMediaError } from '$lib/mediaSegmented';
import type { MediaRef } from '$lib/media';
import { MediaDecryptError, mediaFailureCause } from './mediaErrors';

vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('./mediaTouch', () => ({ noteMediaCacheHit: () => {} }));

const { acquireDecryptedMediaBlobUrl, releaseDecryptedMediaBlobUrl } =
  await import('./mediaBlobCache');

const PLAIN = new Uint8Array(Array.from({ length: 10_000 }, (_, i) => (i * 7) & 0xff));

/** Serves `blob` for any media id, and captures every Blob turned into a URL. */
function serve(blob: ArrayBuffer) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(blob.slice(0), { status: 200 })))
  );
  const made: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    made.push(b as Blob);
    return `blob:test/${made.length}`;
  });
  return made;
}

function refOf(id: string, keyHex: string, ivHex: string, encoding?: string): MediaRef {
  return {
    type: 'video',
    mediaId: id,
    key: keyHex,
    iv: ivHex,
    mimeType: 'video/mp4',
    size: PLAIN.byteLength,
    ...(encoding ? { encoding } : {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('acquireDecryptedMediaBlobUrl', () => {
  it('reads a legacy single-block blob exactly as before', async () => {
    const sealed = await encryptMediaBuffer(PLAIN.buffer);
    const made = serve(sealed.ciphertext);
    const ref = refOf('legacy-1', sealed.keyHex, sealed.ivHex);
    await acquireDecryptedMediaBlobUrl(ref, 'https://media.test');
    expect(new Uint8Array(await made[0].arrayBuffer())).toEqual(PLAIN);
    releaseDecryptedMediaBlobUrl(ref);
  });

  it('reads a segmented blob when the ref says so', async () => {
    const sealed = await encryptSegmentedMedia(PLAIN.buffer, 4096);
    const made = serve(sealed.ciphertext);
    const ref = refOf('seg-1', sealed.keyHex, sealed.ivHex, 'segmented-v1');
    await acquireDecryptedMediaBlobUrl(ref, 'https://media.test');
    expect(new Uint8Array(await made[0].arrayBuffer())).toEqual(PLAIN);
    expect(made[0].type).toBe('video/mp4');
    releaseDecryptedMediaBlobUrl(ref);
  });

  it('refuses an encoding it does not know, rather than reading it as a single block', async () => {
    const sealed = await encryptMediaBuffer(PLAIN.buffer);
    serve(sealed.ciphertext);
    const ref = refOf('future-1', sealed.keyHex, sealed.ivHex, 'proto-9');
    const err = await acquireDecryptedMediaBlobUrl(ref, 'https://media.test').catch((e) => e);
    // Written by a newer client: nothing is damaged, so it is never called corrupt.
    expect(err).toBeInstanceOf(SegmentedMediaError);
    expect(err.fault).toBe('encoding');
    expect(mediaFailureCause(err)).toBe('other');
  });

  it('calls a segmented blob with a tampered segment corrupt, carrying the segment', async () => {
    const sealed = await encryptSegmentedMedia(PLAIN.buffer, 4096);
    const bytes = new Uint8Array(sealed.ciphertext);
    bytes[20 + 4096 + 16 + 100] ^= 0x01; // inside segment 1
    serve(bytes.buffer);
    const ref = refOf('seg-tampered', sealed.keyHex, sealed.ivHex, 'segmented-v1');
    const err = await acquireDecryptedMediaBlobUrl(ref, 'https://media.test').catch((e) => e);
    expect(err).toBeInstanceOf(MediaDecryptError);
    expect(err.cause.fault).toBe('segment-auth');
    expect(err.cause.segmentIndex).toBe(1);
    expect(mediaFailureCause(err)).toBe('corrupt');
  });
});
