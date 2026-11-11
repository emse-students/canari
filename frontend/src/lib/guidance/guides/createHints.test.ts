/**
 * THE CREATE HINTS (post, event, form): each is a one-time hint on ITS route only, keeps every step on
 * both layouts (no `when`, no per-layout anchor - the page's own controls serve phone and desktop),
 * and the anchors it names are the ones the pages mark (asserted on the page sources, so a renamed
 * anchor fails here rather than silently skipping the step in production).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { planGuide } from '../guideEngine.svelte';
import type { GuideLayout } from '../guideTypes';
import { isHelpId } from '../helpIds';
import { GUIDES } from './index';
import { createEventHint } from './createEventHint';
import { createFormHint } from './createFormHint';
import { createPostHint } from './createPostHint';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));

const PHONE: GuideLayout = { phone: true, swipe: true, nativeTabBar: false };
const DESKTOP: GuideLayout = { phone: false, swipe: false, nativeTabBar: false };
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '../../..', rel), 'utf8');

const CASES = [
  {
    guide: createPostHint,
    route: '/posts',
    files: ['routes/posts/+page.svelte', 'lib/components/navigation/MobileHeader.svelte'],
  },
  { guide: createEventHint, route: '/calendar', files: ['routes/calendar/+page.svelte'] },
  { guide: createFormHint, route: '/forms/create', files: ['routes/forms/create/+page.svelte'] },
];

describe('the bubbles keep clear of the bars', () => {
  it('every bar the placement reads is marked in its component', () => {
    for (const file of [
      'lib/components/navigation/BottomNav.svelte',
      'lib/components/navigation/MobileHeader.svelte',
      'lib/components/navigation/Navbar.svelte',
    ])
      expect(src(file), file).toContain('data-guide-chrome');
    expect(src('lib/components/guidance/GuideOverlay.svelte')).toContain(
      'usableBand(window.innerHeight, chromeBars())'
    );
  });
});

describe.each(CASES)('$guide.id', ({ guide, route, files }) => {
  it('is a hint under a listed id, registered, applying to its route only', () => {
    expect(isHelpId(guide.id)).toBe(true);
    expect(guide.kind).toBe('hint');
    expect(GUIDES).toContain(guide);
    expect(guide.appliesTo(route)).toBe(true);
    for (const other of CASES.filter((c) => c.route !== route))
      expect(guide.appliesTo(other.route)).toBe(false);
    expect(guide.steps.length).toBeGreaterThanOrEqual(1);
    expect(guide.steps.length).toBeLessThanOrEqual(3);
  });

  it('keeps every step on the phone and on the desktop once its anchors are drawn', () => {
    const anchors = guide.steps.map((s) => s.anchor as string);
    for (const layout of [PHONE, DESKTOP]) {
      const { steps, skipped } = planGuide(guide, layout, (a) => anchors.includes(a));
      expect(steps.map((s) => s.id)).toEqual(guide.steps.map((s) => s.id));
      expect(skipped).toEqual([]);
    }
  });

  it('leaves a step out, not-rendered, where its control is not drawn', () => {
    const { steps, skipped } = planGuide(guide, PHONE, () => false);
    expect(steps).toEqual([]);
    expect(skipped.every((s) => s.reason === 'not-rendered')).toBe(true);
  });

  it('names anchors the page really marks', () => {
    const source = files.map(src).join('\n');
    for (const step of guide.steps)
      expect(source).toContain(`use:guideAnchor={'${step.anchor as string}'}`);
  });
});

it('puts the welcome tour first, so a hint never precedes it', () => {
  expect(GUIDES[0].id).toBe('welcome-tour');
});
