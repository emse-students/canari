/**
 * THE PIN GATE CANNOT BE WALKED AWAY FROM, AND IT ALWAYS OFFERS ONE WAY OUT.
 *
 * Reported by the user on 2026-09-05: people who forget their PIN do not reset it, they CLOSE this
 * modal - and since the session bootstrap raises it again on the next page, they walk the whole app
 * closing it, browsing a client whose messaging is dead without ever being told so.
 *
 * `pinrows.mjs --row 11` measured it on the local estate the same day and both halves were true:
 * Escape closed the gate, a backdrop click closed the gate, and `exits: {signOut: 0, reset: 0,
 * leaves: 0}` said the modal carried no way out at all in its default state - the reset and the
 * account link both sit behind a disclosure nobody had opened.
 *
 * SO THE TWO HALVES ARE ASSERTED TOGETHER, because either one alone is a defect. A gate with no
 * exit is a softlock, and an exit that appears only after a person goes looking for it is the same
 * thing with extra steps. The campaign row asks the running app the same question; this asks the
 * component, on every commit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import { m } from '$lib/paraglide/messages';
import PinModal from './PinModal.svelte';

const mounted: (() => void)[] = [];
let stopHistoryStack: () => void;

beforeEach(() => {
  stopHistoryStack = initHistoryOverlayStack();
  vi.spyOn(history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  stopHistoryStack();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Raises the gate exactly as `ChatBackgroundService` does, and hands back its handles. */
function raiseGate(props: Record<string, unknown> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const onSignOut = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PinModal, {
    target,
    props: { open: true, onSubmit, onClose, onSignOut, ...props },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  const panel = document.querySelector('[role="dialog"]') as HTMLElement;
  return { onSubmit, onClose, onSignOut, panel };
}

/** Every button on the gate, by the text a person reads on it. */
const buttons = () =>
  [...document.querySelectorAll('button')].map((b) => ({
    el: b,
    text: b.textContent?.trim() ?? '',
  }));

/** The one control that ends the session - found the way a person finds it, by its label. */
const signOutButton = () => buttons().find((b) => b.text.includes(m.auth_pin_sign_out()));

/**
 * A DISMISSAL IS NOT OBSERVED BY LOOKING FOR THE DIALOG - it is still there either way.
 *
 * `open` is the parent's state, so the panel only leaves the DOM once `ChatBackgroundService` has
 * reacted to `onClose`; a test asserting on `[role=dialog]` would pass against a modal that had
 * just told its parent to close it. What a dismissal actually DOES from inside the component is
 * reach `closeHistoryOverlayFromUi`, which calls `history.back()` - so that call is the event, and
 * the parent's callback is its consequence. Both are asserted, in that order.
 */
function expectNothingDismissed(onClose: ReturnType<typeof vi.fn>) {
  expect(history.back).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
}

describe('PinModal - the gate', () => {
  it('is still there after Escape', () => {
    const { onClose, panel } = raiseGate();

    (panel.querySelector('button') ?? panel).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );

    expectNothingDismissed(onClose);
  });

  it('is still there after a click on the backdrop', () => {
    const { onClose } = raiseGate();
    const backdrop = document.querySelector('[data-keyboard-aware-overlay]') as HTMLElement;

    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expectNothingDismissed(onClose);
  });

  it('is still there after a back press, which is how it is closed on a phone', () => {
    const { onClose } = raiseGate();

    // The event a WebView delivers when the physical Back button is pressed. It closes whatever
    // overlay pushed the top history entry - so the gate's protection is having pushed none.
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('carries no close button in its header', () => {
    const { panel } = raiseGate();

    expect(panel.querySelector('[aria-label="Fermer"]')).toBeNull();
  });

  it('offers the sign-out without anything having to be opened first', () => {
    raiseGate();

    // NOT behind the "forgot my PIN" disclosure: the person who needs this exit is the person who
    // cannot get past the gate, and one they have to go looking for is the softlock again.
    expect(signOutButton()).toBeTruthy();
  });

  it('offers it on the first PIN setup too, where a person is just as stuck', () => {
    raiseGate({ isFirstSetup: true });

    expect(signOutButton()).toBeTruthy();
  });

  it('ends the session when the sign-out is pressed', () => {
    const { onSignOut } = raiseGate();

    signOutButton()!.el.click();

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the sign-out pressable while an unlock is in flight', () => {
    // A submit that hangs is one of the states this exit exists for, and the watchdog that unblocks
    // the keypad is ten seconds long. Disabling it here would rebuild the softlock inside the fix.
    raiseGate({ isLoading: true });

    expect(signOutButton()!.el.disabled).toBe(false);
  });

  it('leaves the destructive reset where it was, behind its disclosure', () => {
    // The fix must not be read as "put every exit on screen". Erasing the message history is not an
    // answer to a forgotten PIN, it is the last resort, and it keeps its two deliberate steps.
    raiseGate({ onForgotPinReset: vi.fn() });

    expect(buttons().some((b) => b.text.includes(m.auth_pin_reset_button()))).toBe(false);
    expect(buttons().some((b) => b.text.includes(m.auth_pin_forgot()))).toBe(true);
  });
});

/**
 * A REFUSED UNLOCK THAT IS NEVER ANNOUNCED IS A SILENT ONE, AND SILENCE IS THE FAILURE MODE HERE.
 *
 * The error was a bare `<p>` inserted after the submit. An insertion carrying neither `role` nor
 * `aria-live` is one assistive technology has no reason to read out: a user who cannot see the
 * screen types a PIN, hears nothing, and has no way to learn the attempt was refused or why. The
 * gate above cannot be walked away from - so a person in that state is stuck at a modal that has
 * already told them the answer, in a way they cannot receive.
 *
 * IT WAS FOUND BECAUSE AN INSTRUMENT HIT THE SAME WALL. `pin.mjs` had no handle but a Tailwind
 * colour class, so it keyed on `text-red-500` - a test against a STYLE, which a restyle turns into
 * a silent pass. `role="alert"` is now both the announcement and the handle, which is why this is
 * asserted on the ROLE and never on the class.
 */
describe('PinModal - the refusal is announced', () => {
  const alerts = () => [...document.querySelectorAll('[role="dialog"] p[role="alert"]')];

  it('announces the reason a PIN was refused', () => {
    raiseGate({ externalError: 'Votre PIN a ete change sur un autre appareil' });

    const spoken = alerts();
    expect(spoken).toHaveLength(1);
    expect(spoken[0].textContent).toContain('Votre PIN a ete change sur un autre appareil');
  });

  it('announces it in the KEYPAD shape too, which is the one a phone gets', () => {
    // TWO SHAPES, TWO SITES, AND THE TEST HAD TO BE MADE TO FAIL BEFORE IT COULD BE BELIEVED.
    // `useNumpad` is set from `isCoarsePointerDevice()` on mount, which is false under happy-dom -
    // so the assertion above only ever exercised the manual-input branch, and removing the role
    // from the keypad's `<p>` left it green. The component offers the switch as a button, so this
    // reaches the other shape the way a person does.
    raiseGate({ externalError: 'PIN incorrect' });
    const toKeypad = buttons().find((b) => b.text.includes(m.auth_pin_numeric_keypad()));
    expect(toKeypad, 'the manual shape must offer a way back to the keypad').toBeTruthy();
    toKeypad!.el.click();
    flushSync();

    const spoken = alerts();
    expect(spoken).toHaveLength(1);
    expect(spoken[0].textContent).toContain('PIN incorrect');
  });

  it('says nothing when nothing was refused', () => {
    // The counterpart matters as much: a live region that is always present announces on every
    // render, and a gate that speaks when nothing happened teaches its listener to ignore it.
    raiseGate();

    expect(alerts()).toHaveLength(0);
  });
});
