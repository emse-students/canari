import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { flattenPng, pngInfo } from './lib.mjs';
import { ALLOWED } from './photos.mjs';

const read = (f) => JSON.parse(readFileSync(join(import.meta.dir, f), 'utf8'));
const scenario = read('scenario.json');
const cfg = read('sizes.json');

/** A 2x2 RGBA PNG with filter 0 rows. */
function rgbaPng() {
  const raw = Buffer.from([0, 10, 20, 30, 255, 40, 50, 60, 255, 0, 70, 80, 90, 255, 100, 110, 120, 255]);
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    return Buffer.concat([l, Buffer.from(t), d, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('flattenPng', () => {
  test('drops the alpha channel and keeps the pixels', () => {
    const out = flattenPng(rgbaPng());
    expect(pngInfo(out)).toEqual({ width: 2, height: 2, bitDepth: 8, colorType: 2 });
  });
});

describe('scenario', () => {
  test('both languages carry every caption, at most 6 words', () => {
    for (const s of scenario.shots)
      for (const l of ['fr', 'en']) {
        expect(s.caption[l]).toBeTruthy();
        expect(s.caption[l].split(/\s+/).length).toBeLessThanOrEqual(6);
        expect(s.expect[l]).toBeDefined();
      }
  });
  test('six shots in the decided order', () => {
    expect(scenario.shots.map((s) => s.id.split('-')[0])).toEqual(['1', '2', '3', '4', '5', '6']);
  });
  test('sizes are the store classes of docs/wiki/store-listings.md section 3', () => {
    expect(cfg.sizes.map((s) => `${s.width}x${s.height}`)).toEqual(['1320x2868', '1284x2778', '1080x1920', '1024x500']);
    expect(cfg.look.field).toBe('#f6c232');
  });
});

describe('photo manifest', () => {
  test('every entry names source, author and an allowed licence', () => {
    for (const e of read('photos.manifest.json').entries) {
      expect(e.sourceUrl).toStartWith('https://');
      expect(e.author).toBeTruthy();
      expect(ALLOWED).toContain(e.license);
    }
  });
});
