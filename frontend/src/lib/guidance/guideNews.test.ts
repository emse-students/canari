/**
 * THE "WHAT'S NEW" MECHANISM AND THE HINT PUT-BACK, over test declarations: no what's-new ships in
 * this batch (the 1.6.4 news is written when 1.6.4's content is known), so the mechanism is proved
 * on made-up ids, cast to `HelpId` - the allowlist only holds ids that exist.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GuideEngine, type GuideEnvironment } from './guideEngine.svelte';
import type { GuideDefinition, GuideLayout } from './guideTypes';
import type { HelpId } from './helpIds';
import { GUIDES } from './guides';
import { welcomeTour } from './guides/welcomeTour';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));

const PHONE: GuideLayout = { phone: true, swipe: true, nativeTabBar: false };
const text = () => 'x';
const step = (id: string) => ({ id, anchor: 'a', title: text, body: text });

const news = (version: string): GuideDefinition => ({
  id: `whats-new-${version}` as HelpId,
  kind: 'hint',
  news: true,
  appliesTo: (p) => p === '/posts',
  steps: [step('only')],
});
const tour: GuideDefinition = {
  id: 'welcome-tour',
  kind: 'tour',
  supersedesNews: true,
  appliesTo: (p) => p === '/posts',
  steps: [step('one')],
};

function harness(guides: GuideDefinition[], seen: HelpId[] = []) {
  const seenSet = new Set<HelpId>(seen);
  const env: GuideEnvironment = {
    layout: () => PHONE,
    isAnchorRendered: () => true,
    isSeen: (id) => seenSet.has(id),
    seenReady: () => true,
    markSeen: (id) => seenSet.add(id),
    situation: () => 's',
  };
  return { engine: new GuideEngine(guides, env), seen: seenSet };
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../../../package.json'), 'utf8')) as {
  version: string;
};
/** `1.6.4-alpha.3` -> `1-6-4`: the version a what's-new id must name. */
const baseVersionId = (v: string) => v.replace(/-.*$/, '').replaceAll('.', '-');

describe("what's new is declared for THIS version only", () => {
  it('names the base version of frontend/package.json in every declared id', () => {
    for (const g of GUIDES.filter((x) => x.news)) {
      expect(g.id, `${g.id} is stale for app ${pkg.version}`).toBe(
        `whats-new-${baseVersionId(pkg.version)}`
      );
    }
  });

  it('declares at most one, and strips a pre-release suffix', () => {
    expect(GUIDES.filter((g) => g.news).length).toBeLessThanOrEqual(1);
    expect(baseVersionId('1.6.4-alpha.3')).toBe('1-6-4');
    expect(baseVersionId('1.6.4')).toBe('1-6-4');
  });

  it('marks the tour as superseding the news, by derivation (no literal list)', () => {
    expect(welcomeTour.supersedesNews).toBe(true);
  });
});

describe("the 'what's new' engine rules", () => {
  it('offers an existing account the news once, and nothing more once it is seen', () => {
    const v = harness([tour, news('1-6-4')], ['welcome-tour']);
    v.engine.consider(true, '/posts');
    expect(v.engine.activeId).toBe('whats-new-1-6-4');
    v.engine.end('finished');
    expect(v.seen.has('whats-new-1-6-4' as HelpId)).toBe(true);
    // The next visit: the account has seen the current news, so nothing starts.
    const next = harness([tour, news('1-6-4')], [...v.seen]);
    next.engine.consider(true, '/posts');
    expect(next.engine.view).toBeNull();
  });

  it("offers a new version's news once, to an account that saw the previous one", () => {
    const v = harness([tour, news('1-6-5')], ['welcome-tour', 'whats-new-1-6-4' as HelpId]);
    v.engine.consider(true, '/posts');
    expect(v.engine.activeId).toBe('whats-new-1-6-5');
    v.engine.end('skipped');
    const next = harness([tour, news('1-6-5')], [...v.seen]);
    next.engine.consider(true, '/posts');
    expect(next.engine.view).toBeNull();
  });

  it('never offers the news to an account that has not met the tour', () => {
    const v = harness([news('1-6-4')]);
    v.engine.consider(true, '/posts');
    expect(v.engine.view).toBeNull();
  });

  it('records EVERY declared news with the tour met for the first time, and not on a replay', () => {
    const v = harness([tour, news('1-6-4')]);
    v.engine.consider(true, '/posts');
    expect(v.engine.activeId).toBe('welcome-tour');
    v.engine.end('skipped');
    expect(v.seen.has('whats-new-1-6-4' as HelpId)).toBe(true);
    const replay = harness([tour, news('1-6-4')], ['welcome-tour']);
    replay.engine.request('welcome-tour');
    replay.engine.consider(true, '/posts');
    replay.engine.end('finished');
    expect(replay.seen.has('whats-new-1-6-4' as HelpId)).toBe(false);
  });

  it('never runs on the same visit as another help', () => {
    const v = harness([tour, news('1-6-4')], ['welcome-tour']);
    v.engine.consider(true, '/posts');
    v.engine.end('finished');
    v.engine.consider(true, '/posts');
    expect(v.engine.view).toBeNull();
  });
});

describe('a hint left by navigation before its last step', () => {
  const twoSteps: GuideDefinition = {
    id: 'hint-feed-tabs',
    kind: 'hint',
    appliesTo: (p) => p === '/posts',
    steps: [step('one'), step('two')],
  };

  it('is put back unseen, not recorded', () => {
    const v = harness([twoSteps]);
    v.engine.consider(true, '/posts');
    v.engine.end('navigation');
    expect(v.seen.has('hint-feed-tabs')).toBe(false);
  });

  it('is recorded when left on its last step, or finished or skipped on an early one', () => {
    for (const how of ['last-nav', 'skip'] as const) {
      const v = harness([twoSteps]);
      v.engine.consider(true, '/posts');
      if (how === 'last-nav') {
        v.engine.next();
        v.engine.end('navigation');
      } else {
        v.engine.end('skipped');
      }
      expect(v.seen.has('hint-feed-tabs')).toBe(true);
    }
  });
});
