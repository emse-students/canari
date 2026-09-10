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
 * IT SHIPPED WITH A BASELINE OF 39 FOR ONE DAY, AND THAT WAS DELIBERATE. Collapsing 24px and 32px
 * corners onto the scale changes how the app LOOKS - the call overlay, the login card, the post
 * forms, the emoji picker - and a design decision does not belong inside a refactor hiding behind a
 * green test. The user took it (2026-09-09, "fidele a la reference"), the 39 were mapped onto the
 * four meanings, and the number below is now what it should always have been.
 *
 * THE RULE IT ENCODES IS THE REPOSITORY'S, NOT A NEW ONE: read the scale before reaching for a
 * number (CLAUDE.md, "COLOUR, TYPE AND RADIUS ARE ALL SCALED SINCE #447").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allMarkup } from './markupSources';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cssPath = join(src, 'app.css');

const ALL_MARKUP = allMarkup(src);

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

  it('has no arbitrary corners at all - every one of them is a meaning the design does not make', () => {
    const found: string[] = [];
    for (const { file, body } of ALL_MARKUP) {
      for (const m of body.matchAll(/\brounded(?:-[a-z]+)?-\[[^\]]+\]/g))
        found.push(`${file}: ${m[0]}`);
    }

    expect(
      found,
      'The radius scale in app.css has four meanings - 8px card, 12px larger card, 18px bubble, ' +
        '999px pill - and a number here is a fifth one the design does not make. Use ' +
        'rounded-lg / rounded-2xl / rounded-3xl / rounded-full. Offenders: ' +
        found.slice(0, 12).join(' | ')
    ).toEqual([]);
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
