/**
 * Pure rules for the store listing texts and screenshots, shared by `play.mjs` and its test.
 *
 * WHY a rule file apart from the uploader: a text naming a removed feature (Stripe, audio calls)
 * is a false claim in a public store, and it must be refused in CI, not discovered by a reviewer
 * of the store page. The limits are the stores' own, enforced here rather than truncated.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Directory holding one JSON per language. */
export const LISTINGS_DIR = new URL('../../store/listings/', import.meta.url).pathname.replace(
  /^\/(?=[A-Za-z]:)/,
  ''
);

/** Character limits: Play title/short/full, App Store subtitle/promo/keywords/description. */
export const LIMITS = {
  'play.title': 30,
  'play.shortDescription': 80,
  'play.fullDescription': 4000,
  'appStore.subtitle': 30,
  'appStore.promotionalText': 170,
  'appStore.keywords': 100,
  'appStore.description': 4000,
};

/** Claims that are false, unnamed on purpose, or superlative. Matched case-insensitively. */
export const FORBIDDEN = [
  /stripe/i,
  /\bappels?\b/i,
  /\bcalls?\b/i,
  /\bmeilleure?s?\b/i,
  /\bbest\b/i,
  /\bn[°o]\s?1\b/i,
  /canari-emse\.fr/i,
  /lydia/i,
];

const URL_FIELDS = ['play.contactWebsite', 'appStore.supportUrl', 'appStore.marketingUrl'];

/** @returns {Record<string, any>} language file stem -> parsed content */
export function loadListings(dir = LISTINGS_DIR) {
  const out = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    out[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  return out;
}

/** Read a dotted path such as `play.title`. */
export const pick = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

/**
 * Check one listing file.
 *
 * @param {string} lang file name stem, `fr` or `en`
 * @param {any} listing parsed JSON
 * @returns {string[]} one message per violation, empty when valid
 */
export function validateListing(lang, listing) {
  const errors = [];
  for (const [path, max] of Object.entries(LIMITS)) {
    const value = pick(listing, path);
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${lang}: ${path} is missing`);
      continue;
    }
    const length = [...value].length;
    if (length > max) errors.push(`${lang}: ${path} is ${length} > ${max}`);
  }
  for (const path of [...Object.keys(LIMITS), ...URL_FIELDS]) {
    const value = pick(listing, path);
    if (typeof value !== 'string') continue;
    for (const re of FORBIDDEN) if (re.test(value)) errors.push(`${lang}: ${path} matches ${re}`);
  }
  for (const path of URL_FIELDS) {
    if (pick(listing, path) !== 'https://canari.emse.fr') {
      errors.push(`${lang}: ${path} must be https://canari.emse.fr`);
    }
  }
  for (const path of ['play.fullDescription', 'appStore.description']) {
    if (!/Les Rootz/.test(pick(listing, path) ?? '')) {
      errors.push(`${lang}: ${path} lacks the independent-app disclaimer (Les Rootz)`);
    }
  }
  if (/,\s|\s,/.test(pick(listing, 'appStore.keywords') ?? '')) {
    errors.push(`${lang}: appStore.keywords must be comma-separated with no spaces`);
  }
  return errors;
}

/**
 * Both languages must say the same thing: same bullet count in every description.
 *
 * @returns {string[]} violations
 */
export function validateParity(listings) {
  const errors = [];
  const bullets = (t) => (t.match(/^•/gm) ?? []).length;
  const counts = Object.entries(listings).map(([l, v]) => [
    l,
    bullets(v.play.fullDescription),
    bullets(v.appStore.description),
  ]);
  for (const [l, play, store] of counts) {
    if (play !== counts[0][1] || store !== counts[0][2]) {
      errors.push(`${l}: bullet count differs from ${counts[0][0]}`);
    }
    if (play !== store) errors.push(`${l}: Play and App Store descriptions differ in bullet count`);
  }
  return errors;
}

/**
 * Pixel size of a PNG or JPEG without a dependency.
 *
 * @param {Buffer} buf file content
 * @returns {{width:number,height:number,type:'png'|'jpeg',alpha:boolean}}
 */
export function imageInfo(buf) {
  if (buf.subarray(1, 4).toString() === 'PNG') {
    const colorType = buf[25];
    return {
      type: 'png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      alpha: colorType === 4 || colorType === 6,
    };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) throw new Error('bad JPEG marker');
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          type: 'jpeg',
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
          alpha: false,
        };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error('not a PNG or JPEG');
}

/**
 * Play size rules (verified 2026-10-09, store-listings.md section 3). Types: phoneScreenshots,
 * sevenInchScreenshots, tenInchScreenshots, featureGraphic, icon.
 *
 * @returns {string[]} violations for one image
 */
export function validatePlayImage(type, info, name = type) {
  const errors = [];
  const { width: w, height: h } = info;
  if (info.alpha) errors.push(`${name}: alpha channel not allowed`);
  if (type === 'featureGraphic') {
    if (w !== 1024 || h !== 500) errors.push(`${name}: feature graphic must be 1024x500, is ${w}x${h}`);
  } else if (type === 'icon') {
    if (w !== 512 || h !== 512) errors.push(`${name}: icon must be 512x512, is ${w}x${h}`);
  } else {
    const [lo, hi] = type === 'phoneScreenshots' ? [320, 3840] : [1080, 7680];
    if (Math.min(w, h) < lo || Math.max(w, h) > hi) {
      errors.push(`${name}: sides must be ${lo}-${hi}, is ${w}x${h}`);
    }
    if (Math.max(w, h) > 2.3 * Math.min(w, h)) {
      errors.push(`${name}: long side exceeds 2.3x the short side (${w}x${h})`);
    }
  }
  return errors;
}

/**
 * Validate an images directory laid out as `<dir>/<play-language>/<type>/<file>.png|jpg`.
 *
 * @returns {string[]} violations
 */
export function validateImagesDir(dir) {
  const errors = [];
  for (const lang of readdirSync(dir)) {
    const langDir = join(dir, lang);
    if (!statSync(langDir).isDirectory()) continue;
    for (const type of readdirSync(langDir)) {
      const files = readdirSync(join(langDir, type)).filter((f) => /\.(png|jpe?g)$/i.test(f));
      if (files.length > 8) errors.push(`${lang}/${type}: ${files.length} images, at most 8`);
      for (const f of files) {
        const name = `${lang}/${type}/${f}`;
        try {
          const info = imageInfo(readFileSync(join(langDir, type, f)));
          errors.push(...validatePlayImage(type, info, name));
        } catch (e) {
          errors.push(`${name}: ${e.message}`);
        }
      }
    }
  }
  return errors;
}
