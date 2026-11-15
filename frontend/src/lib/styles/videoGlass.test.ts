/**
 * THE VIDEO PLAYER'S BASE RECIPE HAS NO BLUR, AND ONLY iOS ADDS ONE ON TOP (owner, 2026-11-15, "Faux verre
 * sans flou partout", then "small differences are acceptable when they give each platform its best").
 *
 * The Mi 9T measured a 12 px backdrop blur over a playing 1080p video at 98-99 % janky frames against
 * 38-44 % flat (`docs/wiki/frontend/modules/video-player.md`, "the glass budget"). The transient pieces
 * (the raised bar, the volume slider, the time bubble, the pops) are FAKE GLASS: a translucent dark fill,
 * a hairline, an inner highlight and a shadow, with no `backdrop-filter`. The blur lives in ONE rule,
 * `[data-glass='blur']`, which `utils/videoGlass.ts` gives to iOS alone. Each rule below is one line a
 * later edit could change without any other test noticing.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', '..', 'app.css'), 'utf8').replace(/\r\n/g, '\n');

/** The body of the first block opened by `head`, up to its first closing brace at column 0. */
function block(head: string): string {
  const start = css.indexOf(head);
  expect(start, `${head} is in app.css`).toBeGreaterThan(-1);
  const rest = css.slice(start);
  return rest.slice(0, rest.indexOf('\n}'));
}

describe('the video fake glass', () => {
  it.each(['.glass-video {', '.glass-video-shape {'])('%s carries no backdrop filter', (head) => {
    const rule = block(head);
    expect(rule).not.toMatch(/backdrop-filter/);
    expect(rule).toContain('var(--glass-video-fill)');
    expect(rule).toContain('var(--glass-video-sheen)');
  });

  it('has a hairline, a rim and a shadow, all from tokens', () => {
    const recipe = block('.glass-video {');
    for (const token of ['--glass-video-edge', '--glass-video-rim', '--glass-video-shadow']) {
      expect(recipe).toContain(`var(${token})`);
    }
  });

  it("the blur is one rule, on `[data-glass='blur']`, over the same recipe with a lighter fill", () => {
    const rule = block(".glass-video[data-glass='blur'],");
    expect(rule).toContain('backdrop-filter: var(--glass-video-blur);');
    expect(rule).toContain('-webkit-backdrop-filter: var(--glass-video-blur);');
    expect(rule).toContain('var(--glass-video-sheen)');
    expect(rule).toContain('var(--glass-video-fill-blur)');
    expect(css.match(/backdrop-filter: var\(--glass-video-blur\)/g)).toHaveLength(2); // the rule's two spellings, nowhere else
  });

  it('has no raw hex in its tokens', () => {
    const tokens = css.split('\n').filter((l) => /^\s*--glass-video-/.test(l));
    expect(tokens.length).toBeGreaterThan(4);
    for (const line of tokens) expect(line).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it.each(['@media (prefers-reduced-transparency: reduce) {', '@media (prefers-contrast: more) {'])(
    'goes near-solid under %s',
    (head) => {
      const body = block(head);
      expect(body).toContain('--glass-video-fill: var(--glass-video-fill-solid);');
      expect(body).toContain('--glass-video-sheen: none;');
      // The blur enhancement is switched off too, and its fill is the solid one.
      expect(body).toContain('--glass-video-blur: none;');
      expect(body).toContain('--glass-video-fill-blur: var(--glass-video-fill-solid);');
    }
  );

  it('only iOS adds the blur: no player source blurs on its own, and one function decides', () => {
    const playerDir = join(here, '..', 'components', 'ui', 'player');
    const files = readdirSync(playerDir)
      .filter((f) => f.endsWith('.svelte'))
      .map((f) => join(playerDir, f));
    files.push(join(here, '..', 'components', 'shared', 'VideoPlayer.svelte'));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), `${file} blurs`).not.toMatch(
        /backdrop-filter|backdrop-blur/
      );
    }
    const decider = readFileSync(join(here, '..', 'utils', 'videoGlass.ts'), 'utf8');
    expect(decider).not.toContain('ANDROID_VIDEO_GLASS');
    expect(decider).not.toContain('deviceMemory');
  });
});
