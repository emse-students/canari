import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadListings,
  validateImagesDir,
  validateListing,
  validateParity,
  validatePlayImage,
} from './listings.mjs';

const listings = loadListings();

describe('store/listings', () => {
  test('both languages exist', () => expect(Object.keys(listings).sort()).toEqual(['en', 'fr']));
  for (const [lang, listing] of Object.entries(listings)) {
    test(`${lang} respects limits and names no removed feature`, () =>
      expect(validateListing(lang, listing)).toEqual([]));
  }
  test('fr and en say the same thing', () => expect(validateParity(listings)).toEqual([]));

  test('rejects Stripe, calls and overflow', () => {
    const bad = structuredClone(listings.fr);
    bad.play.fullDescription += ' Paiement Stripe et appels audio.';
    bad.play.title = 'x'.repeat(31);
    const errors = validateListing('fr', bad).join('\n');
    expect(errors).toContain('stripe');
    expect(errors).toContain('appels');
    expect(errors).toContain('play.title is 31 > 30');
  });
});

/** Minimal PNG header: signature, IHDR with the given size and color type. */
function png(w, h, colorType = 2) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = colorType;
  return b;
}

describe('images', () => {
  const ok = { alpha: false };
  test('Play size rules', () => {
    expect(validatePlayImage('phoneScreenshots', { width: 1080, height: 2340, ...ok })).toEqual([]);
    expect(validatePlayImage('phoneScreenshots', { width: 1080, height: 2340, alpha: true })).toHaveLength(1);
    expect(validatePlayImage('featureGraphic', { width: 1024, height: 500, ...ok })).toEqual([]);
    expect(validatePlayImage('featureGraphic', { width: 1000, height: 500, ...ok })).toHaveLength(1);
    expect(validatePlayImage('phoneScreenshots', { width: 300, height: 2000, ...ok }).length).toBeGreaterThan(0);
  });

  test('a directory is checked end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'listing-images-'));
    mkdirSync(join(dir, 'fr-FR', 'phoneScreenshots'), { recursive: true });
    writeFileSync(join(dir, 'fr-FR', 'phoneScreenshots', 'ok.png'), png(1080, 2340));
    writeFileSync(join(dir, 'fr-FR', 'phoneScreenshots', 'alpha.png'), png(1080, 2340, 6));
    expect(validateImagesDir(dir)).toEqual([expect.stringContaining('alpha.png: alpha channel')]);
  });
});
