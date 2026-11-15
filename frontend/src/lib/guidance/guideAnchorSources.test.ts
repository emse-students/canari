/**
 * EVERY ANCHOR A GUIDE NAMES IS MARKED BY A CONTROL: a step pointing at an id no source file marks
 * is a spotlight that can never be drawn - the help would silently skip it. The id is looked for as
 * a literal (`'calendar.deposit'`) or as the stem of a template (`nav.${place.id}`), on every layout
 * a step can resolve on. The geometry itself (the ring hugging the control) is pinned by
 * `GuideOverlay.svelte.test.ts` and `guideAnchorFollow.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { GUIDES } from './guides';
import { byLayout } from './guideEngine.svelte';
import type { GuideLayout } from './guideTypes';
import { sourceFiles } from '../../test/sourceTree';

const LAYOUTS: GuideLayout[] = [
  { phone: true, swipe: true, nativeTabBar: false },
  { phone: false, swipe: false, nativeTabBar: false },
  { phone: true, swipe: true, nativeTabBar: true },
];

describe('the anchors the guides name', () => {
  // The run's source snapshot: hand-written code only (the generated trees mark no control).
  const files = sourceFiles({
    under: 'src',
    extensions: ['svelte', 'ts'],
    tests: 'exclude',
  }).filter(({ path }) => !path.includes('lib/guidance/guides'));
  const corpus = files.map(({ text }) => text).join('\n');

  it('reads the tree it thinks it does: a control that marks an anchor is in the corpus', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.map((f) => f.path)).toContain('src/lib/guidance/guideEngine.svelte.ts');
  });

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
