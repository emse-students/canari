/**
 * EVERY ANCHOR A GUIDE NAMES IS MARKED BY A CONTROL: a step pointing at an id no source file marks
 * is a spotlight that can never be drawn - the help would silently skip it. The id is looked for as
 * a literal (`'calendar.deposit'`) or as the stem of a template (`nav.${place.id}`), on every layout
 * a step can resolve on. The geometry itself (the ring hugging the control) is pinned by
 * `GuideOverlay.svelte.test.ts` and `guideAnchorFollow.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDES } from './guides';
import { byLayout } from './guideEngine.svelte';
import type { GuideLayout } from './guideTypes';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(svelte|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const LAYOUTS: GuideLayout[] = [
  { phone: true, swipe: true, nativeTabBar: false },
  { phone: false, swipe: false, nativeTabBar: false },
  { phone: true, swipe: true, nativeTabBar: true },
];

describe('the anchors the guides name', () => {
  const corpus = sourceFiles(SRC)
    .filter((file) => !file.includes(`${join('lib', 'guidance', 'guides')}`))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  const named = new Set<string>();
  for (const guide of GUIDES) {
    for (const step of guide.steps) {
      for (const layout of LAYOUTS) {
        const id = byLayout(step.anchor, layout);
        if (id) named.add(id);
      }
    }
  }

  it('names some anchors', () => {
    expect(named.size).toBeGreaterThan(10);
  });

  it.each([...named])('%s is marked by a control', (id) => {
    const stem = id.slice(0, id.lastIndexOf('.') + 1);
    const literal = corpus.includes(`'${id}'`) || corpus.includes(`"${id}"`);
    const template = stem !== '' && corpus.includes(`${stem}\${`);
    expect(literal || template).toBe(true);
  });
});
