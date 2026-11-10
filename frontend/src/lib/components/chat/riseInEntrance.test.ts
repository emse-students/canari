/**
 * THE ENTRANCE ANIMATION CANNOT LEAVE A ROW INVISIBLE (owner's Android 1.6.8, 2026-11-09: rows
 * received as notifications appeared only at the second open of the conversation).
 *
 * A new row plays `animate-rise-in` (`shouldAnimate`, `ChatMessageGroups`), which starts at
 * `opacity: 0`. Had it a `forwards`/`both` fill or a keyframe ending below full opacity, a row whose
 * animation was cut short could stay invisible until a re-render - the other explanation of the
 * report. The animation fills nothing and ends opaque, so once it stops the row is its own style,
 * whatever interrupted it. The gate reads the rule, since no rendering test runs an animation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/app.css', 'utf8');

describe('.animate-rise-in', () => {
  it('fills nothing, so a stopped animation leaves the row as its own style', () => {
    const rule = css.match(/\.animate-rise-in \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/animation:\s*riseIn\b/);
    expect(rule).not.toMatch(/forwards|backwards|both|animation-fill-mode/);
  });

  it('ends fully opaque and in place', () => {
    const keyframes = css.match(/@keyframes riseIn \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const to = keyframes.match(/to \{([^}]*)\}/)?.[1] ?? '';
    expect(to).toMatch(/opacity:\s*1;/);
    expect(to).toMatch(/transform:\s*translateY\(0\);/);
  });
});
