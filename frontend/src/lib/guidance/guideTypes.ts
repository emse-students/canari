import type { Component } from 'svelte';
import type { HelpId } from './helpIds';

/**
 * THE DECLARATION OF A FIRST-TIME HELP - what a guided tour or a single hint is made of
 * (docs/wiki/frontend/guided-help.md). A help is DATA: an id from the allowlist, where it applies,
 * and an ordered list of steps. The engine (`guideEngine.svelte.ts`) decides when it runs, which
 * steps it skips and when it is seen; the overlay (`GuideOverlay.svelte`) draws it. Neither knows
 * any particular help.
 */

/**
 * What the engine knows about the layout the help is shown on, read once when the help starts (and
 * again on a viewport change). Every field is a FACT of the running app, never a guess:
 *
 * - `phone`: below Tailwind `md` - the bottom bar and the phone header are drawn, the sidebar is not
 *   (`isPhoneViewport`).
 * - `swipe`: the swipe between tabs works here (`isSwipeNavViewport`) - narrow, or a finger.
 * - `nativeTabBar`: the iOS app draws the bottom bar natively, so its tabs are not page elements;
 *   it registers each tab as a REGION covering the bar (`registerGuideRegion`).
 */
export interface GuideLayout {
  readonly phone: boolean;
  readonly swipe: boolean;
  readonly nativeTabBar: boolean;
}

/**
 * Where the bubble sits against its target. `auto` takes the side with the most room; a step with
 * no anchor is always centred.
 */
export type GuidePlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right';

/** A gesture the bubble mimes, for a place reached by a gesture rather than a control. */
export type GuideGesture = 'swipe-right';

/**
 * A value fixed for the help, or read off the layout - so one step can differ phone to desktop. The
 * wrapper is an object, not a bare function, because a Paraglide message IS a function: a bare
 * `(layout) => T` could not be told apart from the message it returns.
 */
export type ByLayout<T> = T | { readonly byLayout: (layout: GuideLayout) => T };

export interface GuideStep {
  /** Stable within the help: the logs name it, the tests address it. */
  readonly id: string;
  /**
   * The anchor id of the control this step points at (`use:guideAnchor={'nav.chat'}` on the
   * control), or `null` for a step about nothing on screen - a welcome, a gesture - which is drawn
   * centred with no halo.
   */
  readonly anchor: ByLayout<string | null>;
  /** The bubble's heading - a Paraglide message, called at render time. */
  readonly title: ByLayout<() => string>;
  /** The bubble's text - a Paraglide message, called at render time. */
  readonly body: ByLayout<() => string>;
  /** Default `auto`. By layout when a control sits in a rail on one layout and a bar on another. */
  readonly placement?: ByLayout<GuidePlacement>;
  /**
   * Whether this step exists on this layout at all. A step whose answer is false is not part of the
   * help there - it is not counted in "n/N" and nothing is said about it.
   */
  readonly when?: (layout: GuideLayout) => boolean;
  /** An icon drawn in the bubble, which also names a target the halo can only approximate. */
  readonly icon?: Component<{ size?: number }>;
  readonly gesture?: GuideGesture;
  /**
   * A button that DOES something, in place of "Next" on this step (the profile-photo prompt's "open
   * MiGallery"). Pressing it runs `run`, then ends the help like "Next" on a last step - so it is
   * recorded as seen exactly as any other end. "Passer" stays beside it.
   */
  readonly action?: { readonly label: () => string; readonly run: () => void };
}

export interface GuideDefinition {
  /** The id recorded as seen on the account: one of `HELP_IDS`. */
  readonly id: HelpId;
  /**
   * `tour`: several steps, modal - the page behind cannot be used while it shows.
   * `hint`: usually one step, not modal - the page stays usable and the bubble points.
   */
  readonly kind: 'tour' | 'hint';
  /** The routes it may START on. It runs only there; a hint whose route is left is put back. */
  readonly appliesTo: (pathname: string) => boolean;
  readonly steps: readonly GuideStep[];
  /**
   * Whether the signed-in account is one this help is FOR, read from the same source the interface
   * draws by (a permission the page already checks) - never a second definition. Absent means "every
   * account". It is read inside the scheduler's effect, so an answer that arrives later (a probe)
   * re-asks the scheduler by itself; until it is `true` the help is simply not offered. A replay
   * from Settings obeys it too, so a help with `eligible` declares no `replay`.
   */
  readonly eligible?: () => boolean;
  /**
   * Marks the "what's new" help of a release: id `whats-new-<major>-<minor>-<patch>`, whose version
   * is the app's own (asserted by `guides/whatsNew.test.ts`). At most one is declared at a time. It
   * is offered only to an account that has already seen the welcome tour: one that has not is new
   * (or not yet shown the tour) and gets the tour, never the news of the version it installed.
   */
  readonly news?: true;
  /**
   * When this help is met for the FIRST time (a replay records nothing extra), every declared
   * `news` help is recorded as seen with it, DERIVED from the declarations: the welcome tour already
   * covers what a new account has not seen, so its next visit must not open with the news.
   */
  readonly supersedesNews?: true;
  /**
   * Makes the help replayable from Settings > Preferences > "Revoir les aides": the label of its
   * button and the route it plays on. The welcome tour has its own row there.
   */
  readonly replay?: {
    readonly label: () => string;
    readonly route: '/posts' | '/chat' | '/bookings';
  };
}

/** Why a help ended. Every one of them records it as seen, except none: an end is an end. */
export type GuideEndReason = 'finished' | 'skipped' | 'escape' | 'back' | 'navigation';
