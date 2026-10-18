/// <reference types="jest" />

import sharp from 'sharp';
import {
  POST_CARD_BACKGROUND,
  POST_CARD_HEIGHT,
  POST_CARD_WIDTH,
  renderPostCard,
} from './post-card-image';

/** A solid-colour PNG of any size, so a test needs no fixture file. */
function solid(width: number, height: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
}

describe('renderPostCard - one shape for every post', () => {
  it('turns a portrait photo into a 1200x630 JPEG', async () => {
    const card = await renderPostCard({ photo: await solid(800, 1400, '#ff0000') });
    const meta = await sharp(card).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([
      POST_CARD_WIDTH,
      POST_CARD_HEIGHT,
      'jpeg',
    ]);
  });

  it('turns a small photo into a 1200x630 JPEG too, enlarging rather than letterboxing', async () => {
    const card = await renderPostCard({ photo: await solid(100, 100, '#00ff00') });
    const { dominant } = await sharp(card).stats();
    const meta = await sharp(card).metadata();
    expect([meta.width, meta.height]).toEqual([POST_CARD_WIDTH, POST_CARD_HEIGHT]);
    expect(dominant.g).toBeGreaterThan(200);
  });

  it('puts a logo in the middle of the brand background, leaving the corners the brand colour', async () => {
    const card = await renderPostCard({ logo: await solid(512, 512, '#ffffff') });
    const meta = await sharp(card).metadata();
    expect([meta.width, meta.height]).toEqual([POST_CARD_WIDTH, POST_CARD_HEIGHT]);
    const pixel = async (left: number, top: number) =>
      (await sharp(card).extract({ left, top, width: 1, height: 1 }).raw().toBuffer()).toJSON()
        .data;
    const [r, g, b] = await pixel(5, 5);
    const bg = Buffer.from(POST_CARD_BACKGROUND.slice(1), 'hex');
    expect(Math.abs(r - bg[0])).toBeLessThan(6);
    expect(Math.abs(g - bg[1])).toBeLessThan(6);
    expect(Math.abs(b - bg[2])).toBeLessThan(6);
    const [cr] = await pixel(POST_CARD_WIDTH / 2, POST_CARD_HEIGHT / 2);
    expect(cr).toBeGreaterThan(240);
  });

  it('is still a full-size card with neither a photo nor a logo', async () => {
    const meta = await sharp(await renderPostCard({})).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([
      POST_CARD_WIDTH,
      POST_CARD_HEIGHT,
      'jpeg',
    ]);
  });

  it('strips the photo metadata - EXIF, GPS included - from what it serves', async () => {
    const withExif = await sharp(await solid(300, 300, '#123456'))
      .withExif({ IFD0: { Copyright: 'someone' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const card = await renderPostCard({ photo: withExif });
    expect((await sharp(card).metadata()).exif).toBeUndefined();
  });

  it('refuses an image over the pixel limit, whatever its byte size - a flat 8000x8000 PNG is tiny on the wire', async () => {
    const flat = await solid(8000, 8000, '#000000');
    expect(flat.length).toBeLessThan(1024 * 1024);
    await expect(renderPostCard({ photo: flat })).rejects.toThrow(/pixel/i);
    await expect(renderPostCard({ logo: flat })).rejects.toThrow(/pixel/i);
  });

  it('rejects bytes that are not an image instead of serving a blank card', async () => {
    await expect(renderPostCard({ photo: Buffer.from('not an image') })).rejects.toThrow(
      /Input buffer/
    );
  });
});
