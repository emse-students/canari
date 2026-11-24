import type { PublishView } from './publishQueue';
import type { ScreenAwakeHolder } from '$lib/mobile/screenAwake';

/** The phases during which the device is doing the work of a publish, rather than waiting. */
const WORKING: ReadonlySet<PublishView['phase']> = new Set([
  'preparing',
  'uploading',
  'publishing',
]);

/**
 * Whether the screen should stay on for these rows: while one is being prepared, sent or created.
 *
 * WHY (2026-11-24, an Android 1.7.3 log): a CanaReel on a slow link, watched by a member who never
 * left the app. The screen went to sleep on its timeout (shortened by battery saver), Android
 * stopped the activity - the page hidden, `[LIFECYCLE] App in background` - and the stopped app
 * lost the network within seconds: every attempt died at its upload. A publish being worked on
 * keeps the screen on, as a call and a live do; a post WAITING for the network, paused or stopped
 * does not, so a queue that cannot progress never holds a phone awake.
 */
export function publishHoldsTheScreen(views: readonly PublishView[]): boolean {
  return views.some((v) => WORKING.has(v.phase));
}

/**
 * The screen hold of THIS tab's pass, asked of the platform only when it is NEWLY wanted: on a row
 * change from nothing worked on to something worked on, and on each return to visible while wanted
 * (the engine drops a wake lock with a hidden page). Never once per progress update - a refused lock
 * says so on every ask, and the runner draws a row per uploaded chunk.
 *
 * Released on every way the pass ends ({@link PublishScreenHold.passEnded}), so a pass that halted,
 * threw, or lost its last post with no row drawn after it never leaves the phone awake.
 */
export class PublishScreenHold {
  private wanted = false;

  constructor(
    private readonly screen: Pick<ScreenAwakeHolder, 'hold' | 'release'>,
    private readonly isVisible: () => boolean,
    private readonly log: (line: string) => void
  ) {}

  /** The runner drew its rows: the screen is wanted while one of them is worked on. */
  rows(views: readonly PublishView[]): void {
    this.want(publishHoldsTheScreen(views), 'a publish is being sent', 'nothing is being sent');
  }

  /** The pass ended, however it ended: nothing of this tab is being sent any more. */
  passEnded(): void {
    this.want(false, '', 'the pass ended');
  }

  /** The page is on screen again: a hold still wanted is asked again, once. */
  becameVisible(): void {
    if (!this.wanted || !this.isVisible()) return;
    this.log('[PUBLISH-QUEUE] screen asked again: back on screen while a publish is being sent');
    void this.screen.hold();
  }

  /** The queue stopped (sign-out). */
  release(): void {
    this.wanted = false;
    this.screen.release();
  }

  private want(hold: boolean, holdWhy: string, releaseWhy: string): void {
    if (hold === this.wanted) return;
    this.wanted = hold;
    if (hold) {
      // Asked only on screen: a hidden page is refused the lock, and `becameVisible` asks again.
      if (this.isVisible()) void this.screen.hold();
      this.log(
        `[PUBLISH-QUEUE] screen held on: ${holdWhy}${this.isVisible() ? '' : ' (asked once back on screen)'}`
      );
    } else {
      this.screen.release();
      this.log(`[PUBLISH-QUEUE] screen released: ${releaseWhy}`);
    }
  }
}
