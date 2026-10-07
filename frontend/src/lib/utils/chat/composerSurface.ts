/**
 * WHAT OCCUPIES THE SPACE UNDER AND AROUND THE COMPOSER: nothing, the attachment menu, or the GIF
 * panel that takes the keyboard's place (user, 2026-10-02, iPhone: *"un panneau de la taille du
 * clavier qui s'ouvre a sa place"*, and the menu that *"ne se ferme pas"*).
 *
 * ONE STATE, BECAUSE THE THREE EXCLUDE EACH OTHER. The menu and the panel used to be two booleans in
 * two components, and nothing said what a keyboard opening, a send or a back press did to either -
 * so each one's closing was whatever its own component happened to handle. Here every event names
 * its effect on every state, and `composerSurface.test.ts` walks the table.
 *
 * `handoff` is the one state that is not a thing on screen: the panel has given way to the text
 * field (it was tapped), and its ROOM stays reserved until the keyboard has risen into it. Without
 * it the composer would drop by the panel's height the instant the panel closed and climb back as
 * the keyboard rose - the jump the user asked to remove. It ends on a FACT, never a clock: the
 * keyboard opened, or the field lost focus (a hardware keyboard: no soft keyboard is coming).
 */

export type ComposerSurface = 'idle' | 'menu' | 'gif' | 'handoff';

/** Why a surface was dismissed without a pick - logged, and identical in effect. */
export type DismissReason = 'outside' | 'escape' | 'back' | 'close';

/** What a menu entry leads to: a system picker or a modal (the surface ends), or the GIF panel. */
export type PickTarget = 'away' | 'gif';

export type ComposerSurfaceEvent =
  | { type: 'menuToggle' }
  | { type: 'dismiss'; reason: DismissReason }
  | { type: 'pick'; target: PickTarget }
  | { type: 'textFocused' }
  | { type: 'textBlurred' }
  | { type: 'keyboardOpened' }
  | { type: 'sent' };

/** The transition function. Pure: every rule of the composer's surface is here and nowhere else. */
export function nextComposerSurface(
  state: ComposerSurface,
  event: ComposerSurfaceEvent
): ComposerSurface {
  switch (event.type) {
    case 'menuToggle':
      return state === 'menu' ? 'idle' : 'menu';
    case 'dismiss':
      return 'idle';
    case 'pick':
      return event.target === 'gif' ? 'gif' : 'idle';
    case 'textFocused':
      // The panel hands its room to the keyboard; an open menu closes (the keyboard is coming).
      if (state === 'gif') return 'handoff';
      if (state === 'menu') return 'idle';
      return state;
    case 'textBlurred':
      // A focus that brought no soft keyboard ends the hand-off; nothing else depends on blur.
      return state === 'handoff' ? 'idle' : state;
    case 'keyboardOpened':
      // The keyboard now holds the room, and a menu never stays over a keyboard. In `gif` the
      // keyboard was raised by the panel's own search field, and the panel stays.
      if (state === 'handoff' || state === 'menu') return 'idle';
      return state;
    case 'sent':
      return 'idle';
  }
}

/** Whether a state keeps a history entry, so Back closes it (`historyOverlayStack`). */
export function surfaceTakesBack(state: ComposerSurface): boolean {
  return state === 'menu' || state === 'gif';
}

/** Whether the panel's ROOM is reserved under the composer (drawn, or being handed to the keyboard). */
export function surfaceReservesPanel(state: ComposerSurface): boolean {
  return state === 'gif' || state === 'handoff';
}

/**
 * The share of the screen a keyboard takes when this device has never shown one here: 0.40 is the
 * iPhone 12's French keyboard with its suggestion bar (336 of 844 pt) and within 3 % of Gboard on the
 * Mi 9T. It is the first opening's guess only - every opening after a keyboard was seen uses that
 * keyboard's measured height ({@link rememberKeyboardHeight}).
 */
export const DEFAULT_KEYBOARD_SHARE = 0.4;
/** Bounds of the first guess, so a tablet or a landscape phone gets a usable panel. */
export const PANEL_MIN_PX = 240;
export const PANEL_MAX_PX = 420;
/**
 * The panel's height while its search field has raised the keyboard: the search row and one row of
 * results, above the keyboard. The composer rises by this much - deliberately: the reader is typing
 * a search, and the results must be on screen.
 */
export const SEARCH_STRIP_PX = 200;

/** The panel's height: the keyboard last measured here, else the first guess from the screen. */
export function gifPanelHeight(remembered: number | null, viewportHeight: number): number {
  if (remembered !== null && remembered > 0) return Math.round(remembered);
  const guess = viewportHeight * DEFAULT_KEYBOARD_SHARE;
  return Math.round(Math.min(PANEL_MAX_PX, Math.max(PANEL_MIN_PX, guess)));
}

/**
 * THE ROOM UNDER THE COMPOSER, IN PX - the one number that keeps it still.
 *
 * The composer sits on whichever is taller: the keyboard (`keyboardOverlap`, read from the viewport)
 * or the reserved panel. So the spacer is the panel's height MINUS what the keyboard already covers:
 * as the keyboard falls the spacer grows by exactly what it uncovers, and as it rises the spacer
 * shrinks by what it takes - both read from the same viewport event, so the composer does not move.
 * While the panel's own search has the keyboard up, the reserve is the keyboard plus the search strip.
 */
export function panelSpacerPx(params: {
  reserved: boolean;
  panelHeight: number;
  keyboardOverlap: number;
  searchFocused: boolean;
}): number {
  if (!params.reserved) return 0;
  const reserve = params.searchFocused
    ? Math.max(params.panelHeight, params.keyboardOverlap + SEARCH_STRIP_PX)
    : params.panelHeight;
  return Math.max(0, Math.round(reserve - params.keyboardOverlap));
}
