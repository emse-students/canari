/**
 * THE VIDEO GLASS GIVES UP ITS BLUR IN THE SAME PLACE AS THE CHROME GLASS, AND ONE MORE (owner,
 * 2026-11-09). Each rule below is one line of `app.css` a later edit could drop without any other
 * test noticing:
 * - every fallback block (`@supports not (backdrop-filter)`, `prefers-reduced-transparency`) flattens
 *   the video glass as well as the chrome glass;
 * - `prefers-contrast: more` flattens the video glass - the one query WebKit exposes;
 * - `[data-glass='flat']` (Android until measured, `utils/videoGlass.ts`) flattens one element;
 * - the blur is 12px, not the chrome's 18px.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.css'),
  'utf8'
).replace(/\r\n/g, '\n');

/** The body of the first block opened by `head`, up to its first closing brace at column 0. */
function block(head: string): string {
  const start = css.indexOf(head);
  expect(start, `${head} is in app.css`).toBeGreaterThan(-1);
  const rest = css.slice(start);
  return rest.slice(0, rest.indexOf('\n}'));
}

const FLAT = [
  '--glass-video-bg: var(--glass-video-flat-bg);',
  '--glass-video-sheen: none;',
  '--glass-video-blur: none;',
];

describe('the video glass', () => {
  it('blurs 12px over a video, with a rim and a sheen', () => {
    expect(css).toContain('--glass-video-blur: blur(12px) saturate(160%);');
    const recipe = block('.glass-video {');
    expect(recipe).toContain('backdrop-filter: var(--glass-video-blur);');
    expect(recipe).toContain('-webkit-backdrop-filter: var(--glass-video-blur);');
    expect(recipe).toContain('var(--glass-video-rim)');
    expect(recipe).toContain('var(--glass-video-sheen)');
  });

  it.each([
    '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {',
    '@media (prefers-reduced-transparency: reduce) {',
    '@media (prefers-contrast: more) {',
  ])('is flat under %s', (head) => {
    const body = block(head);
    for (const line of FLAT) expect(body).toContain(line);
  });

  it("is flat on an element the device decided (`data-glass='flat'`)", () => {
    const body = block(".glass-video[data-glass='flat'] {");
    expect(body).toContain('--glass-video-bg: var(--glass-video-flat-bg);');
    expect(body).toContain('--glass-video-sheen: none;');
    expect(body).toContain('--glass-video-blur: none;');
  });
});
