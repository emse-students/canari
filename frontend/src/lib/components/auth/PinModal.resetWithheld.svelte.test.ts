// @vitest-environment happy-dom
/**
 * ON A PHONE WHOSE `mls.bin` IS PROVEN TO BE ANOTHER ACCOUNT'S, THE GATE OFFERS NO RESET.
 *
 * `mls.bin` is one file per install. When the vaulted key opened it and its credential named
 * another account (`device_holds_other_account`), the "PIN oublie -> Reinitialiser" route would run
 * `handlePinReset` -> `resetDeviceAsFresh` -> `removeMlsState` and delete THAT account's state from
 * this one's session. The decision (2026-10-14): withhold the reset, say why, and leave this account
 * locked out on this phone - the sign-out stays ([auth](../../../../../docs/wiki/frontend/modules/auth.md#the-vault-names-its-account---fixed-2026-10-14)).
 *
 * The modal half is rendered here; the shell half (what decides to withhold it, and the second lock
 * on `handlePinReset` itself) is pinned in `accountSwitchVault.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function raiseGate(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PinModal, {
    target,
    props: { open: true, onSubmit: vi.fn(), onClose: vi.fn(), onSignOut: vi.fn(), ...props },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

const buttonLabelled = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label));

/** Opens the "forgot PIN" box, then arms the reset if it is offered - the two clicks a person makes. */
function walkTheResetRoute(): void {
  buttonLabelled(m.auth_pin_forgot())?.click();
  flushSync();
  buttonLabelled(m.auth_pin_reset_button())?.click();
  flushSync();
}

/** What the shell hands the modal in each state - read from the shell, not restated here. */
const shell = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

describe('PinModal - the reset withheld for another account', () => {
  it('offers no reset, and says why, when the shell withholds it', () => {
    const notice = m.auth_pin_reset_blocked_other_account();
    raiseGate({ onForgotPinReset: undefined, resetWithheldNotice: notice });

    expect(document.body.textContent).toContain(notice);
    walkTheResetRoute();
    expect(buttonLabelled(m.auth_pin_reset_confirm()), 'a reset is reachable').toBeUndefined();
    // The way out that destroys nothing stays.
    expect(buttonLabelled(m.auth_pin_sign_out())).toBeTruthy();
  });

  it('says it on a FIRST-SETUP gate too, where the forgot box is not even drawn', () => {
    const notice = m.auth_pin_reset_blocked_other_account();
    raiseGate({ isFirstSetup: true, resetWithheldNotice: notice });

    expect(document.body.textContent).toContain(notice);
  });

  it('CONTROL: an ordinary gate still reaches the reset, and shows no notice', () => {
    const onForgotPinReset = vi.fn();
    raiseGate({ onForgotPinReset });

    walkTheResetRoute();
    buttonLabelled(m.auth_pin_reset_confirm())?.click();
    flushSync();
    expect(onForgotPinReset).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(m.auth_pin_reset_blocked_other_account());
  });

  it('is wired by the shell: the reset is withheld while the state is proven foreign, or its key unread', () => {
    expect(shell).toContain(
      'onForgotPinReset={deviceHoldsOtherAccount || keyReadRefused ? undefined : handlePinReset}'
    );
    expect(shell).toMatch(
      /resetWithheldNotice=\{deviceHoldsOtherAccount\s+\? m\.auth_pin_reset_blocked_other_account\(\)\s+: keyReadRefused\s+\? m\.auth_pin_reset_withheld_key_unreadable\(\)\s+: ''\}/
    );
  });

  it('withholds it, and says why, when the hardware-held key could not be read (2026-10-23)', () => {
    // A keychain error or a read before the phone's first unlock proves nothing gone: a reset there
    // would erase data a retry opens. The shell sets the flag from the typed code of every failure,
    // and `handlePinReset` refuses on it too (the second lock).
    expect(shell).toContain('keyReadRefused = withholdsResetForUnreadKey(code);');
    expect(shell).toContain('if (keyReadRefused) {');
    const notice = m.auth_pin_reset_withheld_key_unreadable();
    raiseGate({ onForgotPinReset: undefined, resetWithheldNotice: notice });
    expect(document.body.textContent).toContain(notice);
    walkTheResetRoute();
    expect(buttonLabelled(m.auth_pin_reset_confirm()), 'a reset is reachable').toBeUndefined();
  });
});
