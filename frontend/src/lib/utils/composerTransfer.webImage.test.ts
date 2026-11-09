// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { webImageUrlsFromTransfer, dropEffectFor, fetchWebImageFile } from './composerTransfer';

const withData = (data: Record<string, string>): DataTransfer =>
  ({ getData: (t: string) => data[t] ?? '', types: Object.keys(data) }) as unknown as DataTransfer;

describe('webImageUrlsFromTransfer', () => {
  it('reads the address of an image dragged from a web page, once, from both formats', () => {
    const dt = withData({
      'text/uri-list': 'https://cdn.example/a/cat.png\r\n',
      'text/html': '<img src="https://cdn.example/a/cat.png"><img src="https://cdn.example/b.jpg">',
    });
    expect(webImageUrlsFromTransfer(dt)).toEqual([
      'https://cdn.example/a/cat.png',
      'https://cdn.example/b.jpg',
    ]);
  });

  it('skips blob: and data: sources, which no other origin can read', () => {
    const dt = withData({
      'text/html': '<img src="blob:https://m.example/x"><img src="data:image/png;base64,AA">',
    });
    expect(webImageUrlsFromTransfer(dt)).toEqual([]);
  });

  it('ignores a file: URI list', () => {
    expect(webImageUrlsFromTransfer(withData({ 'text/uri-list': 'file:///home/a.png' }))).toEqual(
      []
    );
  });
});

describe('dropEffectFor', () => {
  const eff = (effectAllowed: string) =>
    dropEffectFor({ effectAllowed } as unknown as DataTransfer);

  it('copies when the source allows it', () => {
    expect(eff('all')).toBe('copy');
    expect(eff('copyMove')).toBe('copy');
    expect(eff('uninitialized')).toBe('copy');
  });

  it('follows a move-only or link-only source instead of forcing a drop the browser refuses', () => {
    expect(eff('move')).toBe('move');
    expect(eff('linkMove')).toBe('link');
  });
});

describe('fetchWebImageFile', () => {
  const answer = (type: string, status = 200) =>
    (async () => new Response(new Blob(['x'], { type }), { status })) as unknown as typeof fetch;

  it('turns an image response into a named file', async () => {
    const file = await fetchWebImageFile('https://cdn.example/a/cat', answer('image/png'));
    expect(file.name).toBe('cat.png');
    expect(file.type).toBe('image/png');
  });

  it('classifies a blocked host, an HTTP error and a non-image at the throw', async () => {
    const blocked = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchWebImageFile('https://x.example/a.png', blocked)).rejects.toMatchObject({
      reason: 'unreachable',
    });
    await expect(
      fetchWebImageFile('https://x.example/a.png', answer('image/png', 404))
    ).rejects.toMatchObject({ reason: 'http' });
    await expect(
      fetchWebImageFile('https://x.example/a', answer('text/html'))
    ).rejects.toMatchObject({ reason: 'not-image' });
  });
});
