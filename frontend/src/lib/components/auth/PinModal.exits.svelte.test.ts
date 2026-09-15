/**
 * THE TWO WAYS PAST THE PIN GATE ARE NEVER SCROLLED TO.
 *
 * `PinModal.gate.svelte.test.ts` asserts the gate HAS an exit and that no gesture dismisses it. This
 * asserts the other half, which that one cannot see: that the exit is on screen. The distinction is
 * not pedantic - it is exactly how the defect survived. The modal body is `overflow-y-auto` inside a
 * panel capped at `max-h-[92dvh]`, so a form taller than the screen is never CLIPPED, only scrolled,
 * and every check that asks "does anything overflow its container" answers no.
 *
 * Measured on W3 with the numeric keypad, 2026-09-15, before the fix: at 360 x 640 the form stood
 * 928 px in a 530 px scrollport, the unlock button ended 195 px below the fold and the sign-out
 * button some 398 px below it. A person could see the keypad, type their PIN, and not see the
 * button that submits it - on the one screen in the app they cannot navigate away from.
 *
 * WHAT IS PINNED HERE IS THE REASON THE FIX WORKS, NOT THE PIXELS. happy-dom has no layout, so
 * "below the fold" is unmeasurable here and a geometry assertion would be a stub asserting itself.
 * What IS decidable, and is what a later refactor would break, is STRUCTURE: both controls live
 * outside the scrolling body, and the submit still reaches the form it no longer nests in.
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

function raiseGate(props: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PinModal, {
    target,
    props: { open: true, onSubmit: vi.fn(), onClose: vi.fn(), onSignOut: vi.fn(), ...props },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

/**
 * The scrolling region, found the way the browser finds it rather than by a test hook.
 *
 * `Modal` gives its body `overflow-y-auto` and nothing else in the panel carries that class, so this
 * IS the scrollport. Reading it from the class means a change to how `Modal` scrolls fails this test
 * rather than silently passing it, which is the point of not adding a `data-` handle here.
 */
const scrollport = () => document.querySelector('[role="dialog"] .overflow-y-auto');

const buttonLabelled = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label));

describe('PinModal - the exits do not scroll', () => {
  it('keeps the unlock button out of the scrolling body', () => {
    raiseGate();

    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit, 'the gate must have a submit button').toBeTruthy();
    expect(
      scrollport()?.contains(submit!),
      'the unlock button must not sit in the region that scrolls'
    ).toBe(false);
  });

  it('keeps the sign-out button out of the scrolling body', () => {
    raiseGate();

    const signOut = buttonLabelled(m.auth_pin_sign_out());
    expect(signOut, 'the gate must offer a way out').toBeTruthy();
    expect(
      scrollport()?.contains(signOut!),
      'the way out must not sit in the region that scrolls'
    ).toBe(false);
  });

  it('still submits the form it no longer nests in', () => {
    // A submit button outside its form is inert unless `form=` names one. This is the assertion the
    // whole change rests on: get it wrong and the button renders, looks right, and does nothing.
    raiseGate();

    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!;

    expect(form.id, 'the form needs an id for the footer button to name').toBeTruthy();
    expect(submit.getAttribute('form')).toBe(form.id);
    expect(form.contains(submit), 'the submit button is deliberately outside the form').toBe(false);
  });

  it('holds on the first-setup shape too, which is a different tree', () => {
    // `isFirstSetup` swaps the description for a block three times its height and relabels the
    // submit. The footer is rendered once for both shapes, and this says so rather than assuming it.
    raiseGate({ isFirstSetup: true });

    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.textContent).toContain(m.auth_pin_create());
    expect(scrollport()?.contains(submit)).toBe(false);
    expect(scrollport()?.contains(buttonLabelled(m.auth_pin_sign_out())!)).toBe(false);
  });

  it('holds when the biometric row and the stay-signed-in box are both shown', () => {
    // The tallest returning shape there is, and the one A1 measured at 901 px. Every one of these
    // additions lands in the BODY, so the footer's guarantee is exactly what does not move.
    raiseGate({
      showBiometricButton: true,
      onBiometricRequest: vi.fn(),
      showStaySignedIn: true,
    });

    expect(
      buttonLabelled(m.auth_pin_use_fingerprint()),
      'the biometric row should be up'
    ).toBeTruthy();
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(scrollport()?.contains(submit)).toBe(false);
    expect(scrollport()?.contains(buttonLabelled(m.auth_pin_sign_out())!)).toBe(false);
  });

  it('leaves the destructive reset inside the disclosure, where it scrolls', () => {
    // The counterpart, so "pin it to the footer" cannot creep. Only the two SAFE exits are pinned:
    // the reset destroys message history and stays behind its disclosure and its two-step confirm.
    raiseGate({ onForgotPinReset: vi.fn() });

    const forgot = buttonLabelled(m.auth_pin_forgot())!;
    expect(scrollport()?.contains(forgot), 'the disclosure itself belongs in the body').toBe(true);
  });
});
