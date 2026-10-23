// @vitest-environment happy-dom
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
let phone = true;
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => phone }));

import type { MediaRef } from '$lib/media';
import { GalleryError } from '$lib/reels/gallery';
import { shareBlobOut, shareMediaOut, sharedFileName, shareTextOut } from './shareOut';

/**
 * A shared file's NAME crosses into Rust as the last segment of a cache path, so it must never be
 * a path; the staged copy must never outlive a share that failed; and a decrypted blob URL must be
 * released whatever the sheet does.
 */
const ref = (over: Partial<MediaRef> = {}): MediaRef => ({
  type: 'file',
  mediaId: 'abcdef0123456789',
  key: '',
  iv: '',
  mimeType: 'application/pdf',
  size: 3,
  ...over,
});

const shareCalls = () =>
  invoke.mock.calls.filter(([cmd]) => String(cmd).startsWith('plugin:gallery'));

describe('sharedFileName', () => {
  it('keeps a plain name', () => {
    expect(sharedFileName(ref({ fileName: 'Rapport final.pdf' }))).toBe('Rapport final.pdf');
    expect(sharedFileName(ref({ fileName: 'été.png' }))).toBe('été.png');
  });

  it('never names a path', () => {
    expect(sharedFileName(ref({ fileName: '../../mls.bin' }))).toBe('mls.bin');
    expect(sharedFileName(ref({ fileName: 'C:\\Users\\a\\x.pdf' }))).toBe('x.pdf');
    expect(sharedFileName(ref({ fileName: 'a..b.pdf' }))).toBe('a.b.pdf');
    expect(sharedFileName(ref({ fileName: 'x<y>:z.pdf' }))).toBe('x_y__z.pdf');
  });

  it('falls back to the id and the type when the name is empty', () => {
    expect(sharedFileName(ref({ fileName: '..' }))).toBe('canari-abcdef01.pdf');
    expect(sharedFileName(ref({ mimeType: 'image/jpeg' }))).toBe('canari-abcdef01.jpg');
    expect(sharedFileName(ref({ mimeType: 'image/svg+xml' }))).toBe('canari-abcdef01.svg');
    expect(sharedFileName(ref({ mimeType: 'weird' }))).toBe('canari-abcdef01');
  });
});

describe('shareTextOut / shareBlobOut', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    phone = true;
  });

  it('is unavailable outside the phone apps', async () => {
    phone = false;
    await expect(shareTextOut('hi')).rejects.toMatchObject({ fault: 'unavailable' });
    await expect(shareBlobOut(new Blob(['x']), 'a.txt', 'text/plain')).rejects.toBeInstanceOf(
      GalleryError
    );
    expect(shareCalls()).toEqual([]);
  });

  it('opens the sheet on a text', async () => {
    await shareTextOut('https://example.org');
    expect(shareCalls()).toEqual([['plugin:gallery|share_text', { text: 'https://example.org' }]]);
  });

  it('stages the blob, then shares it under a plain mime type', async () => {
    await shareBlobOut(new Blob(['abc']), 'a.pdf', 'application/pdf; charset=binary');
    const calls = shareCalls();
    expect(calls[0][0]).toBe('plugin:gallery|append_video_chunk');
    const [cmd, args] = calls[calls.length - 1];
    expect(cmd).toBe('plugin:gallery|share_staged');
    expect(args).toMatchObject({ name: 'a.pdf', mime: 'application/pdf' });
  });

  it('discards the staged copy when the sheet does not open', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'plugin:gallery|share_staged') throw new Error('no activity');
      return undefined;
    });
    await expect(shareBlobOut(new Blob(['abc']), 'a.pdf', 'application/pdf')).rejects.toMatchObject(
      { fault: 'failed' }
    );
    expect(shareCalls().map(([cmd]) => cmd)).toContain('plugin:gallery|discard_video');
  });
});

describe('shareMediaOut', () => {
  it('releases the decrypted copy even when the sheet fails', async () => {
    const release = vi.fn();
    const shareBlob = vi.fn(async () => {
      throw new GalleryError('failed', 'x');
    });
    await expect(
      shareMediaOut(ref({ fileName: 'a.pdf' }), {
        acquire: async () => 'blob:x',
        release,
        readBlob: async () => new Blob(['abc']),
        shareBlob,
      })
    ).rejects.toBeInstanceOf(GalleryError);
    expect(shareBlob).toHaveBeenCalledWith(expect.any(Blob), 'a.pdf', 'application/pdf');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
