/**
 * EVERY PIN FORM CARRIES A HIDDEN USERNAME, SO A PASSWORD MANAGER CAN FILE THE PIN UNDER AN ACCOUNT.
 *
 * Chrome printed "Password forms should have (optionally hidden) username fields" beside each PIN
 * form: they ask the manager to keep the PIN (`current-password` / `new-password`) and named no
 * account to keep it under. The three forms - the unlock gate, the change and the recovery - each
 * render `PinAccountField`, and this asserts the field is INSIDE the form (Chrome associates by
 * form), hidden, out of the tab order, and absent when no account is known.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PinModal from './PinModal.svelte';
import ChangePinModal from './ChangePinModal.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function render(
  component: typeof PinModal | typeof ChangePinModal,
  props: Record<string, unknown>
) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- two components, one harness
  const app = mount(component as any, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
}

const field = () =>
  document.querySelector<HTMLInputElement>('input[autocomplete="username"]') ?? null;

const BASE_GATE = { open: true, onSubmit: vi.fn(), onSignOut: vi.fn() };
const BASE_CHANGE = { open: true, onSubmit: vi.fn(), onClose: vi.fn() };

describe('the hidden account field on the PIN forms', () => {
  for (const [name, component, base] of [
    ['the unlock gate', PinModal, BASE_GATE],
    ['the PIN change', ChangePinModal, BASE_CHANGE],
    ['the PIN recovery', ChangePinModal, { ...BASE_CHANGE, variant: 'recover' }],
  ] as const) {
    it(`${name} names the account inside the form, hidden and unfocusable`, () => {
      render(component, { ...base, account: 'user-42' });
      const input = field();
      expect(input).not.toBeNull();
      expect(input!.value).toBe('user-42');
      expect(input!.hidden).toBe(true);
      expect(input!.tabIndex).toBe(-1);
      expect(input!.getAttribute('aria-hidden')).toBe('true');
      // Chrome pairs a username with a password by FORM, so outside it the field is decoration.
      const form = input!.closest('form');
      expect(form).not.toBeNull();
      expect(form!.querySelector('input[type="password"], [role="group"]')).not.toBeNull();
    });

    it(`${name} renders no field when no account is known`, () => {
      render(component, { ...base });
      expect(field()).toBeNull();
    });
  }
});
