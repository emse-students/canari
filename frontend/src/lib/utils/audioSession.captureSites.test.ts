/**
 * EVERY MICROPHONE IS OPENED THROUGH `captureUserMedia` (review of #3018, 2026-11-04).
 *
 * Under a page-set audio session type other than `play-and-record`, WebKit REJECTS an audio
 * `getUserMedia` (`InvalidStateError`). `captureUserMedia` holds the microphone - and so sets that
 * type - before it asks. A capture site that called `getUserMedia` with audio directly would break
 * on an iPhone as soon as the session is `ambient`, which it is from the first tone on; this scan
 * fails on it. A video-only `getUserMedia` (a call's camera) may stay direct. KNOWN GAP: it reads
 * the call's text, so constraints passed as a VARIABLE (`getUserMedia(constraints)`) slip through.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
/** The one implementation, which is allowed to call `getUserMedia` with audio. */
const OWNER = join('lib', 'utils', 'audioSession.ts');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'wasm' || name === 'paraglide' || name === 'proto') continue;
      out.push(...sources(path));
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$|\.test-helper\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

it('no capture site calls getUserMedia with audio except audioSession.ts', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file);
    if (rel === OWNER) continue;
    const text = readFileSync(file, 'utf-8');
    for (const match of text.matchAll(/\.getUserMedia\(/g)) {
      // The constraints of this call: up to its closing parenthesis, which a few lines hold.
      const call = text.slice(match.index, match.index + 400);
      const end = call.indexOf(');');
      const args = end >= 0 ? call.slice(0, end) : call;
      if (/\baudio\b/.test(args))
        offenders.push(`${rel.split(sep).join('/')}: ${args.split('\n')[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
