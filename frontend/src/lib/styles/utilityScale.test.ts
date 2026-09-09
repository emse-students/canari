/**
 * THE SCALES ARE ONLY SCALES FOR AS LONG AS THE MARKUP USES THEM.
 *
 * `app.css` replaced 36 font sizes with seven `--text-*` steps and 14 corners with four `--radius-*`
 * meanings, and CLAUDE.md records that as done. It is not done in the markup: on 2026-09-09 there
 * were **39 arbitrary radii in eight distinct sizes** - 1rem, 1.1rem, 1.25rem, 1.5rem, 2rem, 10px,
 * 14px, 32px - and not one of them is a step on the scale. Nothing reported them. `bun run check`
 * answers 0 errors, `oxlint` is silent, and the only thing that ever named them was an editor
 * tooltip, which is not a gate.
 *
 * A SCALE WITH AN ESCAPE HATCH IS A SUGGESTION. The cost is not tidiness: four meanings are what let
 * a reader tell a card from a bubble at a glance, and a ninth corner nobody declared is a distinction
 * the design does not make. The same reasoning as `layerLadder.test.ts` next door - that one keeps
 * numbers off the z-axis, this one keeps them off the corners.
 *
 * WHY A BASELINE RATHER THAN ZERO. Collapsing 24px and 32px corners onto an 18px scale CHANGES HOW
 * THE APP LOOKS, on panels, the emoji picker and the post forms - that is a design decision and not
 * a refactor, so it is the user's and it is not smuggled in under a test. What this file does today
 * is stop the population GROWING and make it countable: the number below may go down and may never
 * go up. When the sweep happens, the baseline goes to zero and this comment goes with it.
 *
 * THE RULE IT ENCODES IS THE REPOSITORY'S, NOT A NEW ONE: read the scale before reaching for a
 * number (CLAUDE.md, "COLOUR, TYPE AND RADIUS ARE ALL SCALED SINCE #447").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cssPath = join(src, 'app.css');

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, out);
    else if (entry.endsWith('.svelte')) out.push(full);
  }
  return out;
}

/** Markup only: a rule about class lists must not be tripped by a docblock explaining the rule. */
function withoutComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const ALL_MARKUP = svelteFiles(join(src, 'lib'))
  .concat(svelteFiles(join(src, 'routes')))
  .map((file) => ({
    file: relative(src, file),
    body: withoutComments(readFileSync(file, 'utf8')),
  }));

describe('the radius scale', () => {
  /** Every `--radius-*` the theme declares, as a set of CSS lengths. */
  function declaredRadii(): Map<string, string> {
    const css = readFileSync(cssPath, 'utf8');
    const out = new Map<string, string>();
    for (const m of css.matchAll(/--radius-([a-z0-9]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
    return out;
  }

  it('declares a small, named set of meanings rather than a size for every occasion', () => {
    const radii = declaredRadii();

    expect(radii.size).toBeGreaterThan(0);
    // Distinct VALUES, not distinct names: `lg` and `xl` are deliberately both 8px, which is one
    // meaning wearing two names because Tailwind's default `xl` was the over-rounded corner #447
    // removed. Six distinct values would mean the scale had quietly become a palette again.
    expect(new Set(radii.values()).size).toBeLessThanOrEqual(5);
  });

  // The population, and the only direction it may move. Written as a number rather than a list so
  // that fixing any one of them passes without an edit here, and adding one fails.
  const ARBITRARY_RADIUS_BASELINE = 39;

  it('has no MORE arbitrary corners than the day this was measured, and ideally fewer', () => {
    const found: string[] = [];
    for (const { file, body } of ALL_MARKUP) {
      for (const m of body.matchAll(/\brounded(?:-[a-z]+)?-\[[^\]]+\]/g))
        found.push(`${file}: ${m[0]}`);
    }

    const sizes = new Set(found.map((f) => f.slice(f.indexOf('['))));
    expect(
      found.length,
      `Arbitrary corners went UP (${found.length} > ${ARBITRARY_RADIUS_BASELINE}), in ${sizes.size} distinct sizes.\n` +
        `The radius scale in app.css has four meanings - 8px card, 12px larger card, 18px bubble, 999px pill - ` +
        `and a number here is a fifth the design does not make. Use rounded-lg / -2xl / -3xl / -full.\n` +
        found.slice(0, 12).join('\n')
    ).toBeLessThanOrEqual(ARBITRARY_RADIUS_BASELINE);
  });
});

describe('utility spellings Tailwind itself renamed', () => {
  // NOT a list of what this tree happened to contain: these are the renames in Tailwind's own
  // upgrade table. The old spelling still compiles, which is exactly why nothing reports it and why
  // 36 `flex-shrink-0` survived a full migration - the tooltip knew and no gate did.
  const RENAMED: [string, string][] = [
    ['flex-shrink-', 'shrink-'],
    ['flex-grow-', 'grow-'],
    ['overflow-ellipsis', 'text-ellipsis'],
    ['overflow-clip', 'text-clip'],
    ['decoration-clone', 'box-decoration-clone'],
    ['decoration-slice', 'box-decoration-slice'],
  ];

  it.each(RENAMED)('uses no %s, which is now spelled %s', (legacy, current) => {
    const offenders: string[] = [];
    for (const { file, body } of ALL_MARKUP) {
      // Word-boundary-led so `decoration-clone` does not match inside `box-decoration-clone`, the
      // very spelling it asks for.
      for (const m of body.matchAll(new RegExp(`(?<![a-z-])${legacy}[a-z0-9]*`, 'g'))) {
        offenders.push(`${relative('', file)}: ${m[0]}`);
      }
    }

    expect(
      offenders,
      `Tailwind renamed this: use ${current}.\n${offenders.slice(0, 10).join('\n')}`
    ).toEqual([]);
  });
});
