#!/usr/bin/env bun
/**
 * The demo associations' logos: three stylised GEOMETRIC marks in Canari's palette (same approach and
 * colours as tools/dev-avatars/generate.mjs), 256 px PNGs committed next to this file. Invented marks:
 * no existing logo, no real association. they are uploaded once from a bench seat (POST /api/media/upload/public with its session) and set on the demo associations of dev (`logoUrl` = `/api/media/public/<id>`, `logoMediaId`); the group picture (party.png) is set through the group settings.
 *
 *   bun tools/store-screenshots/demo-logos/generate.mjs     writes the PNGs (Chrome renders the SVGs)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const INK = '#151b2c';
const YELLOW = '#f6c232';
const wrap = (bg, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="${bg}"/>${body}</svg>`;

/** key (the seed's association key) -> svg */
export const LOGOS = {
  // Bureau des eleves: a string of party lights over a stage.
  bde: wrap('#2563eb',
    `<path d="M24 88q104 56 208 0" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>` +
    [[56, 106, YELLOW], [104, 122, '#ffffff'], [152, 122, YELLOW], [200, 106, '#ffffff']].map(([x, y, c]) => `<circle cx="${x}" cy="${y + 14}" r="18" fill="${c}"/>`).join('') +
    `<rect x="48" y="184" width="160" height="28" rx="14" fill="${YELLOW}"/>`),
  // Club photo: a camera.
  photo: wrap('#7c3aed',
    `<rect x="40" y="82" width="176" height="124" rx="26" fill="#ffffff"/><rect x="92" y="62" width="72" height="34" rx="12" fill="#ffffff"/>` +
    `<circle cx="128" cy="146" r="40" fill="${INK}"/><circle cx="128" cy="146" r="22" fill="${YELLOW}"/><circle cx="186" cy="108" r="8" fill="#7c3aed"/>`),
  // Club randonnee: two peaks under a sun.
  rando: wrap('#16a34a',
    `<circle cx="178" cy="84" r="26" fill="${YELLOW}"/><path d="M20 206 100 96l54 74 24-30 58 66z" fill="#ffffff"/><path d="M100 96l24 33-24 14-24-14z" fill="${INK}" opacity=".18"/>` +
    `<rect x="20" y="206" width="216" height="14" rx="7" fill="${INK}"/>`),
  // The party group chat's picture (set through the group settings, not a DB write): a disco ball.
  party: wrap('#db2777',
    `<path d="M128 20v36" stroke="${INK}" stroke-width="6"/><circle cx="128" cy="140" r="82" fill="#ffffff"/>` +
    `<path d="M46 140h164M128 58v164M62 96q66 30 132 0M62 184q66-30 132 0" fill="none" stroke="#db2777" stroke-width="5"/>` +
    `<circle cx="98" cy="110" r="14" fill="${YELLOW}"/><circle cx="158" cy="168" r="14" fill="${YELLOW}"/>`),
};

if (import.meta.main) {
  const tmp = mkdtempSync(join(tmpdir(), 'demo-logos-'));
  for (const [key, svg] of Object.entries(LOGOS)) {
    const file = join(tmp, `${key}.svg`);
    writeFileSync(file, svg);
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${join(OUT, `${key}.png`)}`, '--window-size=256,256', `file:///${file.split(String.fromCharCode(92)).join('/')}`], { stdio: 'ignore' });
    console.log('wrote', `${key}.png`);
  }
}
