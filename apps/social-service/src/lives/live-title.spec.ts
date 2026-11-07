import { HttpStatus } from '@nestjs/common';
import { Readable } from 'stream';
import { LIVE_TITLE_MAX_CHARS, liveLimits } from './live.constants';
import { parseLiveTitle } from './lives.service';
import { readBoundedBody } from './read-bounded-body';

/** The status and body a Nest exception would answer. */
function refusal(run: () => unknown): { status: number; body: unknown } {
  try {
    run();
  } catch (e) {
    const err = e as { getStatus: () => number; getResponse: () => unknown };
    return { status: err.getStatus(), body: err.getResponse() };
  }
  throw new Error('expected a refusal, got an answer');
}

describe('a live title (owner, 2026-11-07)', () => {
  it('is optional: absent, null and blank are "no title"', () => {
    expect(parseLiveTitle(undefined)).toBeNull();
    expect(parseLiveTitle(null)).toBeNull();
    expect(parseLiveTitle('   ')).toBeNull();
  });

  it('is trimmed, and holds up to 80 CHARACTERS - code points, not bytes or UTF-16 units', () => {
    expect(LIVE_TITLE_MAX_CHARS).toBe(80);
    expect(parseLiveTitle('  Soirée  ')).toBe('Soirée');
    // 80 emoji are 160 UTF-16 units and 320 UTF-8 bytes, and still 80 characters.
    const emoji = '🐤'.repeat(80);
    expect(parseLiveTitle(emoji)).toBe(emoji);
  });

  it('refuses 81 characters, a line break, a control character and anything not a string', () => {
    for (const raw of ['🐤'.repeat(81), 'a'.repeat(81), 'ligne\nautre', 'tab\there', 7, {}, []]) {
      expect(refusal(() => parseLiveTitle(raw))).toEqual({
        status: HttpStatus.BAD_REQUEST,
        body: { code: 'LIVE_TITLE_INVALID', maxChars: 80 },
      });
    }
  });

  it('is served in the limits with the poster numbers, so no client carries a copy', () => {
    expect(liveLimits()).toMatchObject({
      titleMaxChars: 80,
      posterMaxBytes: 256 * 1024,
      posterEverySegments: 5,
      cardRefreshMs: 15_000,
    });
  });
});

describe('a bounded body names its own refusals', () => {
  const body = (bytes: number) =>
    Object.assign(Readable.from([Buffer.alloc(bytes)]), { headers: {} });
  const poster = {
    what: 'a poster',
    tooLargeCode: 'LIVE_POSTER_TOO_LARGE',
    emptyCode: 'LIVE_POSTER_EMPTY',
  };

  it('types a poster over its bound and an empty one', async () => {
    await expect(readBoundedBody(body(11), 10, poster)).rejects.toMatchObject({
      response: { code: 'LIVE_POSTER_TOO_LARGE', maxBytes: 10 },
    });
    await expect(
      readBoundedBody(Object.assign(Readable.from([]), { headers: {} }), 10, poster)
    ).rejects.toMatchObject({ response: { code: 'LIVE_POSTER_EMPTY' } });
    await expect(readBoundedBody(body(10), 10, poster)).resolves.toHaveLength(10);
  });

  it('keeps the segment answers it always gave', async () => {
    await expect(
      readBoundedBody(Object.assign(Readable.from([]), { headers: {} }), 10)
    ).rejects.toMatchObject({ response: { code: 'LIVE_SEGMENT_EMPTY' } });
    await expect(readBoundedBody(body(11), 10)).rejects.toMatchObject({ status: 413 });
  });
});
