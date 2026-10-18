/**
 * THE GIF RELAY'S POLICY: ONE HOST, HTTPS, A GIF, A CEILING - each refusal a type with its status.
 */
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GIF_MEDIA_REFUSAL_STATUS,
  GifByteCounter,
  GifMediaRefusedError,
  isGifContentType,
  parseKlipyCdnUrl,
} from './gif-media';

const refusalOf = (raw: unknown): string | null => {
  try {
    parseKlipyCdnUrl(raw);
    return null;
  } catch (error) {
    if (error instanceof GifMediaRefusedError) return error.reason;
    throw error;
  }
};

describe('parseKlipyCdnUrl', () => {
  it('accepts a KLIPY CDN URL and drops its fragment', () => {
    const url = parseKlipyCdnUrl('https://static.klipy.com/ii/a/b/c.gif#cn-size=498x280');
    expect(url.href).toBe('https://static.klipy.com/ii/a/b/c.gif');
  });

  it('refuses everything else, each under its own reason', () => {
    expect(refusalOf(undefined)).toBe('missing-url');
    expect(refusalOf(['https://static.klipy.com/a.gif', 'x'])).toBe('missing-url');
    expect(refusalOf('not a url')).toBe('invalid-url');
    expect(refusalOf('http://static.klipy.com/a.gif')).toBe('not-https');
    expect(refusalOf('https://media.giphy.com/a.gif')).toBe('host-not-allowed');
    expect(refusalOf('https://static.klipy.com.evil.example/a.gif')).toBe('host-not-allowed');
    expect(refusalOf('https://api.klipy.com/a.gif')).toBe('host-not-allowed');
    expect(refusalOf('https://u:p@static.klipy.com/a.gif')).toBe('credentials');
    expect(refusalOf('https://static.klipy.com:8443/a.gif')).toBe('non-default-port');
  });

  it('gives every refusal a status, a 4xx for what the request named', () => {
    for (const reason of ['missing-url', 'invalid-url', 'not-https', 'host-not-allowed'] as const) {
      expect(new GifMediaRefusedError(reason).status).toBe(400);
    }
    expect(GIF_MEDIA_REFUSAL_STATUS['too-large']).toBe(413);
    expect(GIF_MEDIA_REFUSAL_STATUS['not-gif']).toBe(415);
    expect(GIF_MEDIA_REFUSAL_STATUS.redirected).toBe(502);
  });
});

describe('isGifContentType', () => {
  it('is image/gif, parameters and case aside', () => {
    expect(isGifContentType('image/gif')).toBe(true);
    expect(isGifContentType('Image/GIF; charset=binary')).toBe(true);
    expect(isGifContentType('image/webp')).toBe(false);
    expect(isGifContentType('text/html')).toBe(false);
    expect(isGifContentType(null)).toBe(false);
  });
});

describe('GifByteCounter', () => {
  const run = async (chunks: Buffer[], max: number, keep: number) => {
    const counter = new GifByteCounter(max, keep);
    const out: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _e, cb) {
        out.push(chunk);
        cb();
      },
    });
    let error: unknown = null;
    await pipeline(Readable.from(chunks), counter, sink).catch((e: unknown) => (error = e));
    return { counter, out: Buffer.concat(out), error };
  };

  it('passes every byte through and keeps a copy under the cache ceiling', async () => {
    const { counter, out, error } = await run([Buffer.from('GIF8'), Buffer.from('9a')], 100, 10);
    expect(error).toBeNull();
    expect(out.toString()).toBe('GIF89a');
    expect(counter.body()?.toString()).toBe('GIF89a');
  });

  it('streams past the cache ceiling and keeps nothing', async () => {
    const { counter, out, error } = await run([Buffer.alloc(6), Buffer.alloc(6)], 100, 10);
    expect(error).toBeNull();
    expect(out.length).toBe(12);
    expect(counter.body()).toBeNull();
  });

  it('refuses the chunk that crosses the ceiling, typed', async () => {
    const { error } = await run([Buffer.alloc(6), Buffer.alloc(6)], 10, 10);
    expect(error).toBeInstanceOf(GifMediaRefusedError);
    expect((error as GifMediaRefusedError).reason).toBe('too-large');
  });
});
