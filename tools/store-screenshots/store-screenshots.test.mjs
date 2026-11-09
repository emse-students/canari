import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { flattenPng, pngInfo, treeProbe } from './lib.mjs';
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
    expect(cfg.sizes.map((s) => `${s.width}x${s.height}`)).toEqual(['1206x2622', '1080x1920', '1024x500']);
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

describe('treeProbe (the iOS page probe, from WDA\'s flattened tree)', () => {
  const el = (type, text, x, y, w, h) => ({ type, text, rect: { x, y, width: w, height: h } });
  test('lists on-screen text in reading order under the language line', () => {
    const out = treeProbe([el('StaticText', 'Second', 20, 300, 100, 20), el('StaticText', 'First', 20, 100, 100, 20), el('StaticText', 'Below', 20, 900, 100, 20)], 'fr', 844).split('\n');
    expect(out).toEqual(['fr', 'First', 'Second']);
  });
  test('an initials circle is reported as [MEDIA], a word or a big letter box is not', () => {
    const out = treeProbe([el('StaticText', 'CG', 20, 100, 40, 40), el('StaticText', 'OK', 20, 200, 200, 40), el('StaticText', 'Lina', 80, 100, 60, 20)], 'en', 844);
    expect(out).toContain('[MEDIA] 1 initials avatar(s) on screen');
  });
  test('the test-environment banner text reaches the text, so verify can refuse it', () => {
    const out = treeProbe([el('StaticText', 'Environnement de test', 10, 60, 300, 20)], 'fr', 844);
    expect(out.includes(scenario.forbiddenOnScreen.find((s) => s === 'Environnement de test'))).toBe(true);
  });
});

describe('ios steps', () => {
  test('every shot declares its iOS navigation, tabs 0-3 or a tap in both languages', () => {
    for (const s of scenario.shots) {
      expect(Array.isArray(s.ios)).toBe(true);
      for (const st of s.ios) expect(st.tab !== undefined ? st.tab >= 0 && st.tab <= 3 : !!(st.tap?.fr && st.tap?.en)).toBe(true);
    }
  });
});
