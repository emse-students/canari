#!/usr/bin/env bun
/**
 * The dev estate's avatars: eight stylised GEOMETRIC portraits in Canari's palette (yellow `#f6c232` and
 * ink `#151b2c` from app.css, and the placeholder's hues), one distinct per demo person, as 256 px PNGs
 * in apps/core-service/dev-avatars/. Invented faces: no photograph, no real person.
 *
 *   bun tools/dev-avatars/generate.mjs     writes the PNGs and index.json (Chrome renders the SVGs)
 *
 * index.json lists only the four invented extra people, whose ids the repository can derive
 * (sha256 of `canari-store-shots:user:<name>`, the same derivation as tools/store-screenshots/seed.mjs).
 * The bench accounts' ids are not in the repository: the dev box names them in
 * `DEV_AVATAR_OVERRIDE_EXTRA` (`id=lina.png,...`). Served only on the dev estate, see
 * apps/core-service/src/users/dev-avatar-override.ts.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'core-service', 'dev-avatars');
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const INK = '#151b2c';
const YELLOW = '#f6c232';

/** name, background, skin, hair colour, hair style, shirt */
const PEOPLE = [
  ['lina', '#f6c232', '#d9a273', INK, 'long', '#db2777'],
  ['mathis', '#2563eb', '#f2c9a0', '#7a4a2b', 'short', YELLOW],
  ['sana', '#7c3aed', '#a86f46', INK, 'bun', '#f6c232'],
  ['tom', '#16a34a', '#f6d5b8', '#ea580c', 'curly', INK],
  ['jade', '#ea580c', '#7a4a2b', INK, 'curly', '#0d9488'],
  ['yanis', '#0d9488', '#d9a273', INK, 'short', '#ffffff'],
  ['lea', '#db2777', '#f2c9a0', '#f6c232', 'long', INK],
  ['noah', '#151b2c', '#a86f46', '#7a4a2b', 'cap', YELLOW],
];
const EXTRA = { jade: 'Jade', yanis: 'Yanis', lea: 'Léa', noah: 'Noah' };
const userId = (n) => createHash('sha256').update(`canari-store-shots:user:${n}`).digest('hex');

function hair(style, c) {
  switch (style) {
    case 'long': return `<rect x="70" y="52" width="116" height="120" rx="48" fill="${c}"/>`;
    case 'bun': return `<circle cx="128" cy="44" r="22" fill="${c}"/><path d="M76 108a52 52 0 0 1 104 0z" fill="${c}"/>`;
    case 'curly': return [78, 102, 128, 154, 178].map((x, i) => `<circle cx="${x}" cy="${i % 2 ? 70 : 78}" r="24" fill="${c}"/>`).join('');
    case 'cap': return `<path d="M72 104a56 56 0 0 1 112 0z" fill="${c}"/><rect x="64" y="100" width="128" height="12" rx="6" fill="${c}"/>`;
    default: return `<path d="M74 112a54 54 0 0 1 108 0c-20-22-88-22-108 0z" fill="${c}"/>`;
  }
}

function svg([, bg, skin, hairColour, style, shirt]) {
  const behind = style === 'long' || style === 'curly' ? hair(style, hairColour) : '';
  const front = style === 'long' || style === 'curly' ? '' : hair(style, hairColour);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="${bg}"/>` +
    `<ellipse cx="128" cy="282" rx="104" ry="86" fill="${shirt}"/><rect x="108" y="150" width="40" height="44" rx="16" fill="${skin}"/>` +
    `${behind}<circle cx="128" cy="112" r="52" fill="${skin}"/>${front}` +
    `<circle cx="110" cy="112" r="5" fill="${INK}"/><circle cx="146" cy="112" r="5" fill="${INK}"/>` +
    `<path d="M108 134q20 18 40 0" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/></svg>`;
}

mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'dev-avatars-'));
for (const p of PEOPLE) {
  const file = join(tmp, `${p[0]}.svg`);
  writeFileSync(file, svg(p));
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${join(OUT, `${p[0]}.png`)}`, '--window-size=256,256', `file:///${file.split(String.fromCharCode(92)).join('/')}`], { stdio: 'ignore' });
  console.log('wrote', `${p[0]}.png`);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(Object.fromEntries(Object.entries(EXTRA).map(([k, name]) => [userId(name), `${k}.png`])), null, 2) + '\n');
