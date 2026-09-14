/**
 * THE LAYER LADDER IS ONLY A LADDER FOR AS LONG AS NOTHING STEPS OFF IT.
 *
 * Before it existed there were nineteen distinct z-index values in this tree and no scale, every
 * one chosen locally against the single neighbour its author happened to think of. That produced
 * two inversions nobody could see by reading the file they lived in - a message-actions sheet under
 * the banner column, and a drawer scrim over the drawer it was meant to sit behind - and the user's
 * report was the general case: *"les panneaux peuvent se retrouver en dessous d'une partie de
 * l'interface, comme les bandeaux"*.
 *
 * A ladder fixes that exactly once. What keeps it fixed is this file: the next window-scale layer
 * cannot be added with a number, because a number fails here and the failure names the rungs.
 *
 * WHY 60 IS THE FLOOR. Below it a z-index is LOCAL - a badge over a card, a chevron over an avatar,
 * competing only with its own siblings inside one component and invisible to everything else.
 * Naming those would imply they can be compared with a modal, which they cannot. Above it, an
 * element is claiming a place in the window, and that is a claim against every other layer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelteFiles, withoutComments } from './markupSources';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cssPath = join(src, 'app.css');

/** The rungs, in the order they are declared - which must also be their numeric order. */
function readLadder(): { name: string; value: number }[] {
  const css = readFileSync(cssPath, 'utf8');
  const rungs: { name: string; value: number }[] = [];
  for (const match of css.matchAll(/--z-([a-z-]+):\s*(\d+);/g)) {
    rungs.push({ name: match[1], value: Number(match[2]) });
  }
  return rungs;
}

describe('the layer ladder', () => {
  const ladder = readLadder();

  it('declares its rungs in ascending order, so reading the file IS reading the stack', () => {
    expect(ladder.length).toBeGreaterThan(10);

    const values = ladder.map((r) => r.value);
    const sorted = [...values].sort((a, b) => a - b);
    // Not `toEqual(sorted)` alone: the message has to say WHICH rung is out of place.
    expect(ladder.map((r) => `${r.name}:${r.value}`).join(' < ')).toBe(
      [...ladder]
        .sort((a, b) => a.value - b.value)
        .map((r) => `${r.name}:${r.value}`)
        .join(' < ')
    );
    expect(values).toEqual(sorted);
  });

  it('gives every rung a distinct value, because a tie is decided by DOM order and nothing else', () => {
    const values = ladder.map((r) => r.value);

    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps every scrim exactly under the thing it dims', () => {
    // A scrim over its own panel does not merely look wrong: it is a full-screen click target, so
    // the panel stops answering. `Sidebar` shipped that way - scrim 42, drawer 40.
    const by = (name: string) => ladder.find((r) => r.name === name)?.value;

    for (const [scrim, panel] of [
      ['nav-scrim', 'nav-rail'],
      ['nav-drawer-scrim', 'nav-drawer'],
      ['popover-scrim', 'popover'],
      ['side-panel-scrim', 'side-panel'],
    ] as const) {
      expect(by(scrim), `${scrim} must exist`).toBeDefined();
      expect(by(panel), `${panel} must exist`).toBeDefined();
      expect(by(scrim)!, `${scrim} must sit under ${panel}`).toBeLessThan(by(panel)!);
    }
  });

  it('puts a sheet the reader opened above the ambient banner, not under it', () => {
    // The inversion this ladder was written for: a full-screen scrim with a banner painted through
    // it reads as a rendering fault, and the sheet is the thing the reader just asked for.
    const banner = ladder.find((r) => r.name === 'banner')!.value;
    const sheet = ladder.find((r) => r.name === 'sheet')!.value;

    expect(sheet).toBeGreaterThan(banner);
  });

  /**
   * Every class attribute in the markup, whitespace collapsed, so an attribute that spans lines is
   * still read as one value. Two components were missed by a line-oriented sweep on 2026-09-13 for
   * exactly that reason.
   */
  function classValues(): { file: string; value: string }[] {
    const out: { file: string; value: string }[] = [];
    for (const file of svelteFiles(join(src, 'lib')).concat(svelteFiles(join(src, 'routes')))) {
      const flat = withoutComments(readFileSync(file, 'utf8')).replace(/\s+/g, ' ');
      for (const match of flat.matchAll(/class=(?:"([^"]*)"|\{([^}]*)\})/g)) {
        out.push({ file: relative(src, file), value: match[1] ?? match[2] ?? '' });
      }
    }
    return out;
  }

  it('is reading the class attributes it thinks it is', () => {
    // The branch below asserts an ABSENCE, so a regex that stopped matching would pass forever.
    const values = classValues();

    expect(values.length).toBeGreaterThan(500);
    expect(
      values.filter((v) => /\bfixed\b/.test(v.value) && /\binset-0\b/.test(v.value)).length
    ).toBeGreaterThan(5);
  });

  it('lets no FULL-VIEWPORT overlay carry a literal number, whatever the number is', () => {
    // THIS IS A SECOND BRANCH RATHER THAN A LOWER FLOOR, and the reason is the floor's own
    // justification. 60 is correct for a `z-10` ordering two children of a card: below it an
    // element competes only with its own siblings, so naming it would imply it can be compared
    // with a modal. `fixed inset-0` breaks that argument completely - such an element is on screen
    // with everything by construction, so its number IS comparable with every other component's,
    // whatever it happens to be.
    //
    // MEASURED, on 2026-09-14: `routes/admin/agenda` sat at `z-50` - between `--z-page-overlay`
    // (40) and `--z-toast` (60) - and its reject dialog opened UNDERNEATH a toast, with this file
    // green. Four more full-viewport overlays carried a raw number on the same day. Lowering the
    // floor to catch them would condemn every local `z-10` in the tree; this branch condemns
    // exactly the case the floor's reasoning excludes.
    const offenders: string[] = [];
    for (const { file, value } of classValues()) {
      if (!/\bfixed\b/.test(value) || !/\binset-0\b/.test(value)) continue;
      for (const z of value.matchAll(/\bz-\[?(\d+)\]?/g)) offenders.push(`${file}: ${z[0]}`);
    }

    expect(
      offenders,
      `A full-viewport overlay is comparable with every other layer, so it takes a rung by NAME - z-(--z-<rung>). Rungs: ${ladder
        .map((r) => r.name)
        .join(', ')}`
    ).toEqual([]);
  });

  it('has no window-scale z-index written as a number anywhere in the markup', () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(join(src, 'lib')).concat(svelteFiles(join(src, 'routes')))) {
      const body = withoutComments(readFileSync(file, 'utf8'));
      // Both spellings Tailwind accepts: the bare `z-160` and the arbitrary `z-[160]`.
      for (const match of body.matchAll(/\bz-\[?(\d+)\]?/g)) {
        if (Number(match[1]) >= 60) offenders.push(`${relative(src, file)}: ${match[0]}`);
      }
    }

    // The message is the point: whoever trips this needs to know a ladder exists and where.
    expect(
      offenders,
      `Window-scale layers take a rung from the ladder in app.css - use z-(--z-<rung>). Rungs: ${ladder
        .map((r) => r.name)
        .join(', ')}`
    ).toEqual([]);
  });
});
