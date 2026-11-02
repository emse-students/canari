/**
 * THE ENGINE'S DECISIONS, WITHOUT A DOM, A SERVER OR A CLOCK: which help starts, which steps a
 * layout shows, what a missing target does, how it ends, and that every end is recorded once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideEngine, planGuide, type GuideEnvironment } from './guideEngine.svelte';
import type { GuideDefinition, GuideLayout, GuideStep } from './guideTypes';
import type { HelpId } from './helpIds';
import { welcomeTour } from './guides/welcomeTour';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));

const PHONE: GuideLayout = { phone: true, swipe: true, nativeTabBar: false };
const DESKTOP: GuideLayout = { phone: false, swipe: false, nativeTabBar: false };

const text = () => 'x';
const step = (id: string, anchor: string | null, extra: Partial<GuideStep> = {}): GuideStep => ({
  id,
  anchor,
  title: text,
  body: text,
  ...extra,
});

/** A tour under the one listed id, so `markSeen` receives a real `HelpId`. */
function tour(steps: GuideStep[], kind: 'tour' | 'hint' = 'tour'): GuideDefinition {
  return { id: 'welcome-tour', kind, appliesTo: (p) => p === '/posts', steps };
}

function harness(guides: GuideDefinition[], options: { layout?: GuideLayout } = {}) {
  const rendered = new Set<string>();
  const seen = new Set<HelpId>();
  let ready = true;
  let situation = 'a';
  const markSeen = vi.fn((id: HelpId) => seen.add(id));
  let layout = options.layout ?? PHONE;
  const env: GuideEnvironment = {
    layout: () => layout,
    isAnchorRendered: (a) => rendered.has(a),
    isSeen: (id) => seen.has(id),
    seenReady: () => ready,
    markSeen,
    situation: () => situation,
  };
  const engine = new GuideEngine(guides, env);
  return {
    engine,
    rendered,
    seen,
    markSeen,
    setReady: (v: boolean) => (ready = v),
    setSituation: (v: string) => (situation = v),
    setLayout: (v: GuideLayout) => (layout = v),
    stepId: () => engine.view?.step.id ?? null,
  };
}

describe('planGuide', () => {
  it('keeps the declared order and leaves out what the layout does not have', () => {
    const rendered = new Set(['nav.posts', 'nav.chat', 'nav.dashboard', 'nav.profile']);
    const { steps, skipped } = planGuide(welcomeTour, PHONE, (a) => rendered.has(a));
    expect(steps.map((s) => s.id)).toEqual([
      'welcome',
      'feed',
      'chats',
      'camera',
      'agenda',
      'profile',
    ]);
    expect(skipped).toEqual([]);
  });

  it('drops the camera on a layout without the swipe, and points the agenda at the rail', () => {
    const rendered = new Set(['nav.posts', 'nav.chat', 'nav.calendar', 'nav.profile']);
    const { steps, skipped } = planGuide(welcomeTour, DESKTOP, (a) => rendered.has(a));
    expect(steps.map((s) => s.id)).toEqual(['welcome', 'feed', 'chats', 'agenda', 'profile']);
    expect(skipped).toEqual([{ step: 'camera', reason: 'layout' }]);
  });

  it('skips at once a step whose anchor the settled layout did not render', () => {
    const rendered = new Set(['nav.posts', 'nav.profile']);
    const { steps, skipped } = planGuide(welcomeTour, DESKTOP, (a) => rendered.has(a));
    expect(steps.map((s) => s.id)).toEqual(['welcome', 'feed', 'profile']);
    expect(skipped).toEqual([
      { step: 'chats', reason: 'not-rendered' },
      { step: 'camera', reason: 'layout' },
      { step: 'agenda', reason: 'not-rendered' },
    ]);
  });
});

describe('GuideEngine', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness([tour([step('one', null), step('two', 'a'), step('three', 'b')])]);
    h.rendered.add('a').add('b');
  });

  it('starts only when quiet, on a route it applies to, once the seen set is known', () => {
    h.engine.consider(false, '/posts');
    expect(h.engine.view).toBeNull();
    h.engine.consider(true, '/chat');
    expect(h.engine.view).toBeNull();
    h.setReady(false);
    h.engine.consider(true, '/posts');
    expect(h.engine.view).toBeNull();
    h.setReady(true);
    h.engine.consider(true, '/posts');
    expect(h.stepId()).toBe('one');
    expect(h.engine.view?.position).toBe(1);
    expect(h.engine.view?.total).toBe(3);
    expect(h.engine.view?.modal).toBe(true);
  });

  it('walks the steps in order, back and forth, and records the finish once', () => {
    h.engine.consider(true, '/posts');
    h.engine.next();
    expect(h.stepId()).toBe('two');
    h.engine.previous();
    expect(h.stepId()).toBe('one');
    h.engine.previous();
    expect(h.stepId()).toBe('one');
    h.engine.next();
    h.engine.next();
    expect(h.stepId()).toBe('three');
    expect(h.engine.view?.position).toBe(3);
    h.engine.next();
    expect(h.engine.view).toBeNull();
    expect(h.markSeen).toHaveBeenCalledTimes(1);
    expect(h.markSeen).toHaveBeenCalledWith('welcome-tour');
  });

  it('does not start a seen help again', () => {
    h.seen.add('welcome-tour');
    h.engine.consider(true, '/posts');
    expect(h.engine.view).toBeNull();
  });

  it.each(['skipped', 'escape', 'back', 'navigation'] as const)(
    'records the help as seen when it ends by %s',
    (reason) => {
      h.engine.consider(true, '/posts');
      h.engine.end(reason);
      expect(h.engine.view).toBeNull();
      expect(h.markSeen).toHaveBeenCalledWith('welcome-tour');
      // Ending twice records nothing more.
      h.engine.end(reason);
      expect(h.markSeen).toHaveBeenCalledTimes(1);
    }
  );

  it('replays a seen help when asked, and only on a route it applies to', () => {
    h.seen.add('welcome-tour');
    h.engine.request('welcome-tour');
    h.engine.consider(true, '/settings/preferences');
    expect(h.engine.view).toBeNull();
    expect(h.engine.requestedId).toBe('welcome-tour');
    h.engine.consider(true, '/posts');
    expect(h.stepId()).toBe('one');
    expect(h.engine.requestedId).toBeNull();
  });

  it('skips a step whose target left after the plan (a breakpoint crossed), never waiting', () => {
    h.engine.consider(true, '/posts');
    h.rendered.delete('a');
    h.engine.next();
    expect(h.stepId()).toBe('three');
    expect(h.engine.view?.total).toBe(2);
    expect(h.engine.view?.position).toBe(2);
  });

  it('re-plans when the layout crosses a breakpoint, so a `when` is read again', () => {
    const g = harness(
      [
        tour([
          step('one', null),
          step('swipe-only', null, { when: (l) => l.swipe }),
          step('three', null),
        ]),
      ],
      { layout: DESKTOP }
    );
    g.engine.consider(true, '/posts');
    expect(g.engine.view?.total).toBe(2);
    // Narrowed to a phone: the swipe step exists now, and the reader stays where they were.
    g.setLayout(PHONE);
    g.engine.layoutChanged();
    expect(g.stepId()).toBe('one');
    expect(g.engine.view?.total).toBe(3);
    g.engine.next();
    expect(g.stepId()).toBe('swipe-only');
    // Widened again ON that step: it leaves the plan, and the next declared step takes its place.
    g.setLayout(DESKTOP);
    g.engine.layoutChanged();
    expect(g.stepId()).toBe('three');
    expect(g.engine.view?.position).toBe(2);
    expect(g.engine.view?.total).toBe(2);
    // Back on a phone on the last step: the swipe step returns BEHIND the reader, who stays put.
    g.setLayout(PHONE);
    g.engine.layoutChanged();
    expect(g.stepId()).toBe('three');
    expect(g.engine.view?.position).toBe(3);
    g.engine.next();
    expect(g.engine.view).toBeNull();
    expect(g.markSeen).toHaveBeenCalledTimes(1);
  });

  it('finishes the help when a layout change leaves no step at or after the current one', () => {
    const g = harness([
      tour([step('one', null), step('swipe-only', null, { when: (l) => l.swipe })]),
    ]);
    g.engine.consider(true, '/posts');
    g.engine.next();
    expect(g.stepId()).toBe('swipe-only');
    g.setLayout(DESKTOP);
    g.engine.layoutChanged();
    expect(g.engine.view).toBeNull();
    expect(g.markSeen).toHaveBeenCalledWith('welcome-tour');
  });

  it('forgets the leaving account on reset: its suspended run never resumes for the next', () => {
    // Account A: the tour runs, then is suspended (a call, a modal) - still active, not ended.
    h.engine.consider(true, '/posts');
    h.engine.next();
    expect(h.stepId()).toBe('two');
    h.engine.consider(false, '/posts');
    expect(h.engine.activeId).toBe('welcome-tour');
    // A signs out; B signs in, and B has seen the tour on another device.
    h.engine.reset();
    h.seen.add('welcome-tour');
    h.engine.consider(true, '/posts');
    expect(h.engine.view).toBeNull();
    expect(h.engine.activeId).toBeNull();
    expect(h.markSeen).not.toHaveBeenCalled();
  });

  it('a pending replay does not survive the account that asked for it', () => {
    h.seen.add('welcome-tour');
    h.engine.request('welcome-tour');
    h.engine.reset();
    h.engine.consider(true, '/posts');
    expect(h.engine.view).toBeNull();
    expect(h.engine.requestedId).toBeNull();
  });

  it('moves on when the layout changes under the step on screen', () => {
    h.engine.consider(true, '/posts');
    h.engine.next();
    expect(h.stepId()).toBe('two');
    h.rendered.delete('a');
    h.engine.layoutChanged();
    expect(h.stepId()).toBe('three');
  });

  it('puts back unseen a help with nothing to show, and does not retry it in the same situation', () => {
    const g = harness([tour([step('only', 'missing')], 'hint')]);
    g.engine.consider(true, '/posts');
    expect(g.engine.view).toBeNull();
    expect(g.engine.activeId).toBeNull();
    expect(g.markSeen).not.toHaveBeenCalled();
    // The same situation: nothing changes, nothing is retried.
    g.rendered.add('missing');
    g.engine.consider(true, '/posts');
    expect(g.engine.view).toBeNull();
    // A new situation (an anchor mounted): offered again, and shown.
    g.setSituation('b');
    g.engine.consider(true, '/posts');
    expect(g.stepId()).toBe('only');
    expect(g.engine.view?.modal).toBe(false);
  });

  it('refuses to replay an id no guide declares', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = harness([]);
    g.engine.request('welcome-tour');
    expect(g.engine.requestedId).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
