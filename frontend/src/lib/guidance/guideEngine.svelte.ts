import { Log } from '$lib/utils/Log';
import type { HelpId } from './helpIds';
import type {
  ByLayout,
  GuideDefinition,
  GuideEndReason,
  GuideLayout,
  GuidePlacement,
  GuideStep,
} from './guideTypes';

/**
 * THE ONE ENGINE BEHIND EVERY GUIDED TOUR AND FIRST-TIME HINT (docs/wiki/frontend/guided-help.md).
 *
 * It decides three things and draws nothing:
 *
 * 1. WHEN a help starts - {@link GuideEngine.consider}, called by the overlay whenever the app's
 *    quiet state, the route or the seen set changes. The first declared help that applies to the
 *    route and is not seen starts, or the one a reader asked to replay.
 * 2. WHICH STEPS it shows - {@link planGuide}, a pure function of the layout and of the anchors the
 *    layout rendered. A step whose anchor is not rendered once the route has settled is skipped AT
 *    ONCE, and the reason is logged: the registry is the list of what is mounted (see
 *    `guideAnchors.svelte.ts`), so absence after the settle is a fact, not a wait that ran out.
 * 3. WHEN it is seen - every end ({@link GuideEndReason}) records it on the account through the
 *    environment, except a help that showed NOTHING, which is put back (it never reached the reader).
 *
 * The environment is injected so the whole decision is testable without a DOM, a server or a clock.
 */

/** What the engine reads from the running app. The production one is in `guidance.svelte.ts`. */
export interface GuideEnvironment {
  layout(): GuideLayout;
  /** Whether the anchor id resolves to something on screen now. */
  isAnchorRendered(anchorId: string): boolean;
  /** Whether the account's seen set is known (the server answered, or the local copy names it). */
  isSeen(id: HelpId): boolean;
  /** Whether an UNSEEN help may start: the server's set has been merged for this account. */
  seenReady(): boolean;
  markSeen(id: HelpId): void;
  /** A key that changes when the app's situation does (route, anchors): see `declined`. */
  situation(): string;
}

/** Resolves a {@link ByLayout} value. */
export function byLayout<T>(value: ByLayout<T>, layout: GuideLayout): T {
  if (value !== null && typeof value === 'object' && 'byLayout' in value) {
    return value.byLayout(layout);
  }
  return value as T;
}

/** Why a step is left out of a run - logged, and asserted by the tests. */
export type StepSkip = { readonly step: string; readonly reason: 'layout' | 'not-rendered' };

/**
 * The steps of `guide` this layout shows, in order. A step leaves the plan when its `when` says the
 * layout has no such step, or when its anchor is not rendered and it does not wait for it.
 */
export function planGuide(
  guide: GuideDefinition,
  layout: GuideLayout,
  isAnchorRendered: (anchorId: string) => boolean
): { steps: GuideStep[]; skipped: StepSkip[] } {
  const steps: GuideStep[] = [];
  const skipped: StepSkip[] = [];
  for (const step of guide.steps) {
    if (step.when && !step.when(layout)) {
      skipped.push({ step: step.id, reason: 'layout' });
      continue;
    }
    const anchor = byLayout(step.anchor, layout);
    if (anchor !== null && !step.waitForAnchor && !isAnchorRendered(anchor)) {
      skipped.push({ step: step.id, reason: 'not-rendered' });
      continue;
    }
    steps.push(step);
  }
  return { steps, skipped };
}

/** The step on screen, everything the overlay needs to draw it. */
export interface GuideView {
  readonly guide: GuideDefinition;
  readonly step: GuideStep;
  readonly anchorId: string | null;
  readonly title: () => string;
  readonly body: () => string;
  readonly placement: GuidePlacement;
  /** 1-based, among the steps this layout shows. */
  readonly position: number;
  readonly total: number;
  /** A tour blocks the page behind; a hint does not. */
  readonly modal: boolean;
}

type Run = {
  guide: GuideDefinition;
  layout: GuideLayout;
  steps: GuideStep[];
  index: number;
  /** `waiting`: the current step waits for its anchor (`waitForAnchor`) - nothing is drawn. */
  phase: 'showing' | 'waiting';
  /** How many steps reached the screen: a run that showed none is put back, never recorded. */
  shown: number;
};

export class GuideEngine {
  #run = $state<Run | null>(null);
  #requested = $state<HelpId | null>(null);
  /**
   * The situation in which a help was put back because it had nothing to show. It is not offered
   * again until the situation changes (another route, an anchor mounted) - otherwise the scheduler
   * would start and drop it in a loop on the very state that made it empty.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- must NOT re-run the scheduler
  #declined = new Map<HelpId, string>();

  constructor(
    private readonly guides: readonly GuideDefinition[],
    private readonly env: GuideEnvironment
  ) {}

  /** The step to draw, or `null` (nothing running, or the step waits for its anchor). */
  get view(): GuideView | null {
    const run = this.#run;
    if (!run || run.phase !== 'showing') return null;
    const step = run.steps[run.index];
    return {
      guide: run.guide,
      step,
      anchorId: byLayout(step.anchor, run.layout),
      title: byLayout(step.title, run.layout),
      body: byLayout(step.body, run.layout),
      placement: byLayout(step.placement ?? 'auto', run.layout),
      position: run.index + 1,
      total: run.steps.length,
      modal: run.guide.kind === 'tour',
    };
  }

  /** The help running (shown or waiting), or `null`. */
  get activeId(): HelpId | null {
    return this.#run?.guide.id ?? null;
  }

  /** The help a reader asked to see again, until it starts. */
  get requestedId(): HelpId | null {
    return this.#requested;
  }

  /**
   * Asks for `id` to run at the next quiet moment, seen or not - the "replay" of Settings. It still
   * waits for a route it applies to and for the app to be quiet, like any start.
   */
  request(id: HelpId): void {
    if (!this.guides.some((g) => g.id === id)) {
      console.error(`[guide] replay asked for ${id}, which no guide declares`);
      return;
    }
    Log.i('guide', `replay of ${id} requested`);
    this.#declined.delete(id);
    this.#requested = id;
  }

  /**
   * The scheduler. Starts a help when the app is quiet and none runs: the one asked for, else the
   * first declared that applies to `pathname` and is not seen. Safe to call on every change.
   */
  consider(quiet: boolean, pathname: string): void {
    if (this.#run || !quiet) return;
    const guide = this.#pick(pathname);
    if (!guide) return;
    this.#start(guide, pathname);
  }

  #pick(pathname: string): GuideDefinition | null {
    const situation = this.env.situation();
    const offered = (g: GuideDefinition) =>
      g.appliesTo(pathname) && this.#declined.get(g.id) !== situation;
    if (this.#requested) {
      const asked = this.guides.find((g) => g.id === this.#requested);
      return asked && offered(asked) ? asked : null;
    }
    if (!this.env.seenReady()) return null;
    return this.guides.find((g) => !this.env.isSeen(g.id) && offered(g)) ?? null;
  }

  #start(guide: GuideDefinition, pathname: string): void {
    const layout = this.env.layout();
    const { steps, skipped } = planGuide(guide, layout, (a) => this.env.isAnchorRendered(a));
    for (const s of skipped) {
      Log.i('guide', `${guide.id}: step ${s.step} left out (${s.reason}) on ${pathname}`);
    }
    if (this.#requested === guide.id) this.#requested = null;
    if (steps.length === 0) {
      this.#decline(guide, 'no step to show on this layout');
      return;
    }
    Log.i('guide', `${guide.id} starts on ${pathname}: ${steps.length} step(s)`);
    this.#run = { guide, layout, steps, index: 0, phase: 'showing', shown: 0 };
    this.#enter(0, 1);
  }

  /** Puts a help back unseen: it showed nothing, so the reader never met it. */
  #decline(guide: GuideDefinition, why: string): void {
    Log.i('guide', `${guide.id} put back unseen: ${why}`);
    this.#declined.set(guide.id, this.env.situation());
    this.#run = null;
  }

  /**
   * Makes step `index` current, moving in `direction` past any step whose anchor is not rendered
   * now (a viewport change since the plan) and does not wait for it. Running off either end ends the
   * help: forward, finished; backward, the first showable step stays.
   */
  #enter(index: number, direction: 1 | -1): void {
    const run = this.#run;
    if (!run) return;
    const from = run.steps[run.index];
    let i = index;
    while (i >= 0 && i < run.steps.length) {
      const step = run.steps[i];
      const anchor = byLayout(step.anchor, run.layout);
      if (anchor === null || this.env.isAnchorRendered(anchor)) {
        this.#run = { ...run, index: i, phase: 'showing', shown: run.shown + 1 };
        Log.d('guide', `${run.guide.id}: step ${step.id} (${i + 1}/${run.steps.length})`);
        return;
      }
      if (step.waitForAnchor) {
        this.#run = { ...run, index: i, phase: 'waiting' };
        Log.d('guide', `${run.guide.id}: step ${step.id} waits for ${anchor}`);
        return;
      }
      Log.i('guide', `${run.guide.id}: step ${step.id} skipped - ${anchor} is no longer rendered`);
      run.steps.splice(i, 1);
      if (direction === -1) i -= 1;
    }
    if (direction === -1) {
      // Nothing showable before: stay on the step the reader was on, wherever the skips moved it.
      this.#run = { ...run, index: Math.max(0, run.steps.indexOf(from)) };
      return;
    }
    this.end('finished');
  }

  /** The reader's "Next" (or the last step's "Done"). */
  next(): void {
    const run = this.#run;
    if (!run || run.phase !== 'showing') return;
    if (run.index + 1 >= run.steps.length) {
      this.end('finished');
      return;
    }
    this.#enter(run.index + 1, 1);
  }

  /** The reader's "Previous". A no-op on the first step. */
  previous(): void {
    const run = this.#run;
    if (!run || run.phase !== 'showing' || run.index === 0) return;
    this.#enter(run.index - 1, -1);
  }

  /**
   * Ends the running help and records it as seen on the account - whatever the reason, because the
   * reader met it: finishing, "Passer", Esc, Back and leaving the page all mean "do not show me this
   * again"; Settings replays it. A help that showed nothing is put back instead.
   */
  end(reason: GuideEndReason): void {
    const run = this.#run;
    if (!run) return;
    if (run.shown === 0) {
      this.#decline(run.guide, `ended (${reason}) before any step was shown`);
      return;
    }
    Log.i('guide', `${run.guide.id} ended: ${reason} at step ${run.index + 1}/${run.steps.length}`);
    this.#run = null;
    this.env.markSeen(run.guide.id);
  }

  /** The anchor registry changed: a waiting step whose anchor arrived is shown. */
  anchorsChanged(): void {
    const run = this.#run;
    if (!run || run.phase !== 'waiting') return;
    const anchor = byLayout(run.steps[run.index].anchor, run.layout);
    if (anchor !== null && this.env.isAnchorRendered(anchor)) this.#enter(run.index, 1);
  }

  /**
   * The route settled on `pathname`. A step still waiting for its anchor is skipped - its page is
   * gone, which is the event that ends the wait - and a help that does not apply to the new route
   * and showed nothing yet is put back for when its route returns.
   */
  routeSettled(pathname: string): void {
    const run = this.#run;
    if (!run || run.phase !== 'waiting') return;
    if (run.shown === 0 && !run.guide.appliesTo(pathname)) {
      this.#decline(run.guide, `its route was left for ${pathname} before it showed`);
      return;
    }
    const step = run.steps[run.index];
    Log.i('guide', `${run.guide.id}: step ${step.id} skipped - the route changed while it waited`);
    run.steps.splice(run.index, 1);
    this.#enter(run.index, 1);
  }

  /**
   * The viewport changed: the layout is read again, and a step on screen whose anchor this layout
   * no longer renders moves on (the breakpoint is the event; nothing is polled).
   */
  layoutChanged(): void {
    const run = this.#run;
    if (!run) return;
    const layout = this.env.layout();
    this.#run = { ...run, layout };
    if (run.phase === 'showing') this.#enter(run.index, 1);
  }
}
