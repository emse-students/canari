/**
 * THE FULL-SCREEN VIEWER'S BARS FOLLOW THE VIDEO'S CONTROLS (owner, 2026-11-09, production 1.6.8:
 * "the header sometimes does not leave" - the back arrow and the time stayed on screen while the
 * video played and its glass bar had faded).
 *
 * Two things hid chrome in the viewer and neither knew of the other: a tap on the viewer toggled its
 * bars (`MediaLightbox.chromeHidden`), while the player's own bar faded on its own timer
 * (`CONTROLS_FADE_MS`) and was unmounted. A playing video therefore left the header up for ever.
 * The viewer now PROVIDES this object and a `lightbox` `VideoPlayer` REPORTS through it: the header,
 * the side arrows and the footer hide exactly when the player's controls are faded and come back
 * with them, on the same clock. Nothing is timed here.
 *
 * It goes the other way too: a mouse over the header or a keyboard focus on its buttons is the
 * reader reaching for them, so the viewer asks the player to raise its controls ({@link raise}),
 * which brings the header back - otherwise a focused Back button would sit at opacity 0.
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('video-viewer-chrome');

/** The state shared between a viewer and the video player it shows. */
export class ViewerChrome {
  /** The player's controls are faded: the viewer's bars follow. False with no video on screen. */
  videoControlsHidden = $state(false);
  /** Bumped when the viewer wants the player's controls up (a mouse or focus on the header). */
  raised = $state(0);

  /** Called by the player whenever its controls fade or come back, and with `false` as it leaves. */
  report(hidden: boolean): void {
    this.videoControlsHidden = hidden;
  }

  /** Asks the player to raise its controls. */
  raise(): void {
    this.raised += 1;
  }
}

/** The viewer calls this once, in its script: its children read the object back. */
export function provideViewerChrome(): ViewerChrome {
  const chrome = new ViewerChrome();
  setContext(KEY, chrome);
  return chrome;
}

/** The viewer's chrome, or `undefined` for a player that is not inside a viewer. */
export function useViewerChrome(): ViewerChrome | undefined {
  return getContext<ViewerChrome | undefined>(KEY);
}
