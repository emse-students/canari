// @vitest-environment happy-dom
/**
 * A PIN CHOSEN AT CREATION IS ASKED TWICE, AND A GATE THAT CANNOT USE A PIN DRAWS NO KEYPAD (PIN
 * audit rows 15, 16 and 18, 2026-11-20). A typo at creation locked its owner out on the next unlock:
 * a PIN cannot be recovered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import { m } from '$lib/paraglide/messages';
import PinModal from './PinModal.svelte';
import { noKeypadNoticeFor } from '$lib/composables/session/loginErrors';

let stop: () => void;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  stop = initHistoryOverlayStack();
  vi.spyOn(history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  if (app) void unmount(app);
  app = null;
  stop();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function raise(extra: Record<string, unknown> = {}) {
  const props = $state({
    open: true,
    pin: '',
    isLoading: false,
    isFirstSetup: true,
    externalError: '',
    gateNotice: '',
    onSubmit: vi.fn(),
    onSignOut: vi.fn(),
    ...extra,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(PinModal, { target, props });
  flushSync();
  const manual = [...document.querySelectorAll('button')].find(
    (b) => b.querySelector('svg') === null && /manuel|manual/i.test(b.textContent ?? '')
  );
  manual?.click();
  flushSync();
  return { props };
}

function field(): HTMLInputElement {
  return document.getElementById('encryption-pin') as HTMLInputElement;
}

function enter(value: string) {
  const f = field();
  f.value = value;
  f.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  document
    .querySelector<HTMLFormElement>('[role="dialog"] form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
}

const heading = () => document.querySelector('[role="dialog"] h1')?.textContent?.trim();
const alertText = () => document.querySelector('[role="alert"]')?.textContent?.trim() ?? '';

describe('PinModal - the PIN is confirmed at creation (row 15)', () => {
  it('asks the chosen PIN a second time before handing it on', () => {
    const { props } = raise();

    enter('1234');
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(heading()).toBe(m.auth_pin_title_confirm());
    expect(field().value).toBe('');

    enter('1234');
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith('1234');
  });

  it('on a different second entry, empties it and asks the confirmation again', () => {
    const { props } = raise();

    enter('1234');
    enter('4321');
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(alertText()).toBe(m.auth_pin_confirm_mismatch());
    expect(heading()).toBe(m.auth_pin_title_confirm());
    expect(field().value).toBe('');

    // The first choice is kept: the confirmation is what starts again.
    enter('1234');
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith('1234');
  });

  it('"Choisir un autre PIN" starts over from the choice', () => {
    const { props } = raise();

    enter('1234');
    document.querySelector<HTMLButtonElement>('[data-pin-choose-another]')!.click();
    flushSync();
    expect(heading()).toBe(m.auth_pin_title_setup());

    enter('5678');
    enter('5678');
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith('5678');
  });

  it('a refusal by the parent drops the chosen PIN: it is chosen and confirmed again', () => {
    const { props } = raise();
    enter('1234');
    enter('1234');

    props.externalError = 'server unreachable';
    flushSync();
    expect(heading()).toBe(m.auth_pin_title_setup());
  });

  it('a returning unlock is never asked twice', () => {
    const { props } = raise({ isFirstSetup: false });

    enter('1234');
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith('1234');
  });
});

describe('PinModal - a gate that cannot use a PIN (rows 16 and 18)', () => {
  it('shows the notice in the keypad place, with no PIN entry and no unlock button', () => {
    raise({ isFirstSetup: false, gateNotice: m.auth_device_revoked_here() });

    expect(document.querySelector('[data-pin-gate-notice]')?.textContent?.trim()).toBe(
      m.auth_device_revoked_here()
    );
    expect(field()).toBeNull();
    expect(document.querySelector('button[type="submit"]')).toBeNull();
    // The way on is the gate's own sign-out, still there.
    expect(document.querySelector('[data-pin-signout]')).not.toBeNull();
  });

  it('a removed device sees none of the PIN exits, even when the parent still hands them', () => {
    // The revoked outcome reaches the gate with whatever an earlier failure left: a recover link,
    // the restart, the forgot-PIN reset, a withheld-reset notice, an error. None may be drawn under
    // the notice - each offers a PIN action a removed device cannot take (review of #3909).
    const { props } = raise({
      isFirstSetup: false,
      gateNotice: noKeypadNoticeFor('device_revoked')!,
      externalError: 'stale error',
      onRecoverPin: vi.fn(),
      onRestartDevice: vi.fn(),
      onForgotPinReset: vi.fn(),
      resetWithheldNotice: 'withheld',
      showStaySignedIn: true,
    });

    expect(document.querySelector('[data-pin-gate-notice]')?.textContent?.trim()).toBe(
      m.auth_device_revoked_here()
    );
    const text = document.querySelector('[role="dialog"]')!.textContent ?? '';
    expect(text).not.toContain(m.auth_pin_recover_link());
    expect(text).not.toContain(m.auth_device_restart_button());
    expect(text).not.toContain(m.auth_pin_forgot());
    expect(text).not.toContain('withheld');
    expect(text).not.toContain('stale error');
    expect(document.querySelector('[data-pin-restart]')).toBeNull();
    expect(document.querySelector('[data-stay-signed-in]')).toBeNull();
    expect(document.querySelector('[data-pin-footer] button')).toBeNull();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('the retry button is disabled while its question is in flight', () => {
    raise({ isFirstSetup: false, gateNotice: 'x', onGateRetry: vi.fn(), isLoading: true });
    const retry = document.querySelector<HTMLButtonElement>('[data-pin-footer] button')!;
    expect(retry.disabled).toBe(true);
  });

  it('offers "Reessayer" when a retry is given, and calls it', () => {
    const onGateRetry = vi.fn();
    raise({ isFirstSetup: false, gateNotice: m.auth_server_unreachable(), onGateRetry });

    const retry = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-pin-footer] button'),
    ].find((b) => b.textContent?.trim() === m.common_retry_button());
    retry!.click();
    expect(onGateRetry).toHaveBeenCalledOnce();
  });
});
