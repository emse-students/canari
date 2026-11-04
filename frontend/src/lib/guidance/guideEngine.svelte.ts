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
 * layout has no such step, or when its anchor is not rendered.
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
    if (anchor !== null && !isAnchorRendered(anchor)) {
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

  /**
   * AT MOST ONE HELP PER VISIT (lead, 2026-11-03): true once a help has SHOWN a step in this visit
   * (this engine's lifetime = one app open or reload, or until sign-out). In-memory on purpose: a visit is "since the
   * page loaded", so no clock and no stored state decide it. A decline (nothing drawn) never sets it,
   * and a replay asked from Settings is exempt from it but sets it - it is the visit's help.
   */
  #shownThisVisit = false;

  constructor(
    private readonly guides: readonly GuideDefinition[],
    private readonly env: GuideEnvironment
  ) {}

  /** The step to draw, or `null` when nothing runs. */
  get view(): GuideView | null {
    const run = this.#run;
    if (!run) return null;
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

  /** The help running, or `null`. */
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
    if (this.#shownThisVisit) return null;
    return (
      this.guides.find(
        (g) => !this.env.isSeen(g.id) && (!g.news || this.env.isSeen('welcome-tour')) && offered(g)
      ) ?? null
    );
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
    this.#run = { guide, layout, steps, index: 0, shown: 0 };
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
   * now (a viewport change since the plan). Running off either end ends the
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
        this.#run = { ...run, index: i, shown: run.shown + 1 };
        this.#shownThisVisit = true;
        Log.d('guide', `${run.guide.id}: step ${step.id} (${i + 1}/${run.steps.length})`);
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
    if (!run) return;
    if (run.index + 1 >= run.steps.length) {
      this.end('finished');
      return;
    }
    this.#enter(run.index + 1, 1);
  }

  /** The reader's "Previous". A no-op on the first step. */
  previous(): void {
    const run = this.#run;
    if (!run || run.index === 0) return;
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
    if (reason === 'navigation' && run.guide.kind === 'hint' && run.index + 1 < run.steps.length) {
      // Left by navigation before the LAST step: nobody read it, so it is offered again later.
      this.#decline(run.guide, `left by navigation at step ${run.index + 1}/${run.steps.length}`);
      return;
    }
    Log.i('guide', `${run.guide.id} ended: ${reason} at step ${run.index + 1}/${run.steps.length}`);
    this.#run = null;
    const first = !this.env.isSeen(run.guide.id);
    this.env.markSeen(run.guide.id);
    if (!first || !run.guide.supersedesNews) return;
    for (const g of this.guides.filter((n) => n.news && !this.env.isSeen(n.id))) {
      Log.i('guide', `${run.guide.id} met for the first time: ${g.id} recorded as seen with it`);
      this.env.markSeen(g.id);
    }
  }

  /**
   * The viewport crossed a breakpoint: the help is PLANNED AGAIN for the new layout, so every `when`
   * and every layout-dependent anchor is read afresh - the camera step appears when the swipe does,
   * and leaves with it. The reader stays on the step they were on when the new layout has it, else
   * moves to the next declared step it has; with none left, the help is finished. The breakpoint is
   * the event; nothing is polled.
   */
  layoutChanged(): void {
    const run = this.#run;
    if (!run) return;
    const layout = this.env.layout();
    const { steps, skipped } = planGuide(run.guide, layout, (a) => this.env.isAnchorRendered(a));
    const declared = run.guide.steps;
    const at = declared.indexOf(run.steps[run.index]);
    const index = steps.findIndex((step) => declared.indexOf(step) >= at);
    Log.i(
      'guide',
      `${run.guide.id}: re-planned for a new layout, ${steps.length} step(s), ${skipped.length} left out`
    );
    if (index < 0) {
      this.#run = { ...run, layout, steps };
      this.end('finished');
      return;
    }
    // The step on screen counts once: re-entering it is not a new step shown.
    const same = steps[index] === run.steps[run.index];
    this.#run = { ...run, layout, steps, index, shown: same ? run.shown : run.shown + 1 };
  }

  /**
   * Forgets everything about the account that was signed in: the run on screen or suspended, a
   * pending replay, the declined situations. Called at sign-out, so account A's half-walked tour
   * never comes back over account B and skips B's own seen set.
   */
  reset(): void {
    if (this.#run || this.#requested) Log.i('guide', 'reset at sign-out');
    this.#run = null;
    this.#requested = null;
    this.#declined.clear();
    // A sign-out starts the next account's visit: it is owed its own first help.
    this.#shownThisVisit = false;
  }
}
