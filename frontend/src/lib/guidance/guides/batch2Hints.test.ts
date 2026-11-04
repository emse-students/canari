/**
 * BATCH 2 - the chats hint, the CanaReels hint, the feed tabs hint (which replaced the (i) button)
 * and the current version's "what's new": each on its route only, every step kept on both layouts
 * once its anchors are drawn, left out where they are not, and the anchors really marked in the
 * sources (a renamed anchor fails here rather than silently skipping the step in production).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { planGuide } from '../guideEngine.svelte';
import type { GuideLayout } from '../guideTypes';
import { isHelpId } from '../helpIds';
import { GUIDES } from './index';
import { chatsHint } from './chatsHint';
import { feedTabsHint } from './feedTabsHint';
import { reelsHint } from './reelsHint';
import { welcomeTour } from './welcomeTour';
import { whatsNew163 } from './whatsNew';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));

const PHONE: GuideLayout = { phone: true, swipe: true, nativeTabBar: false };
const DESKTOP: GuideLayout = { phone: false, swipe: false, nativeTabBar: false };
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '../../..', rel), 'utf8');

const CASES = [
  {
    guide: chatsHint,
    route: '/chat',
    files: ['lib/components/sidebar/SidebarHeaderControls.svelte'],
    anchors: ['chat.new'],
  },
  {
    guide: reelsHint,
    route: '/posts',
    files: ['lib/components/posts/ReelsEntryButton.svelte'],
    anchors: ['posts.reels'],
  },
  {
    guide: feedTabsHint,
    route: '/posts',
    files: ['lib/components/posts/FeedTabRow.svelte'],
    anchors: ['posts.tab.associations', 'posts.tab.followed', 'posts.tab.all'],
  },
];

describe.each(CASES)('$guide.id', ({ guide, route, files, anchors }) => {
  it('is a hint under a listed id, registered, applying to its route only', () => {
    expect(isHelpId(guide.id)).toBe(true);
    expect(guide.kind).toBe('hint');
    expect(GUIDES).toContain(guide);
    expect(guide.appliesTo(route)).toBe(true);
    expect(guide.appliesTo(route === '/chat' ? '/posts' : '/chat')).toBe(false);
  });

  it('keeps every step on both layouts once its anchors are drawn', () => {
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

  it('names anchors the sources really mark', () => {
    const source = files.map(src).join('\n');
    for (const anchor of anchors) {
      const literal = `use:guideAnchor={'${anchor}'}`;
      const perTab =
        anchor.startsWith('posts.tab.') &&
        source.includes('use:guideAnchor={`posts.tab.${tab.feed}`}');
      expect(source.includes(literal) || perTab).toBe(true);
    }
  });
});

describe('the feed tabs hint replaces the (i) button', () => {
  it('has no (i) button left, and keeps the three explanations as its three steps', () => {
    expect(src('lib/components/posts/FeedTabRow.svelte')).not.toContain('FeedTabsInfo');
    expect(feedTabsHint.steps.map((s) => s.id)).toEqual(['associations', 'followed', 'all']);
  });
});

describe("the current version's what's new", () => {
  it('is one hint of 2 to 5 steps on the feed, after the tour and offered only past it', () => {
    expect(isHelpId(whatsNew163.id)).toBe(true);
    expect(whatsNew163.kind).toBe('hint');
    expect(whatsNew163.requires).toBe('welcome-tour');
    expect(whatsNew163.steps.length).toBeGreaterThanOrEqual(2);
    expect(whatsNew163.steps.length).toBeLessThanOrEqual(5);
    expect(GUIDES.indexOf(whatsNew163)).toBe(GUIDES.indexOf(welcomeTour) + 1);
    // Exactly one what's-new is declared: an account is never owed a backlog.
    expect(GUIDES.filter((g) => g.id.startsWith('whats-new-'))).toEqual([whatsNew163]);
  });

  it('is superseded by the welcome tour, so a new account never gets it', () => {
    expect(welcomeTour.supersedes).toEqual([whatsNew163.id]);
  });

  it('keeps every step on both layouts once its anchors are drawn', () => {
    const drawn = new Set(['posts.tab.all', 'nav.chat']);
    for (const layout of [PHONE, DESKTOP]) {
      const { steps, skipped } = planGuide(whatsNew163, layout, (a) => drawn.has(a));
      expect(steps.map((s) => s.id)).toEqual(whatsNew163.steps.map((s) => s.id));
      expect(skipped).toEqual([]);
    }
  });
});
