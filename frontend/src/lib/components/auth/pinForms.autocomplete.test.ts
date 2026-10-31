// @vitest-environment happy-dom
/**
 * A PIN IS NOT A PASSWORD A BROWSER MAY KEEP, AND NO FORM HERE NAMES AN ACCOUNT.
 *
 * Chrome offered "Save password?" under a long hex username. The PIN forms used to carry a hidden
 * `autocomplete="username"` input holding the account id (`PinAccountField`, deleted), and Chrome
 * paired it with the `current-password` / `new-password` PIN input. The PIN is never sent to the
 * server and decrypts the local MLS state, so it is not a credential to file. Every PIN input now
 * declares `one-time-code`, and no input in these forms carries an id.
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

const BASE_GATE = { open: true, onSubmit: vi.fn(), onSignOut: vi.fn() };
const BASE_CHANGE = { open: true, onSubmit: vi.fn(), onClose: vi.fn() };

describe('the PIN forms and the browser password manager', () => {
  for (const [name, component, base] of [
    ['the unlock gate', PinModal, BASE_GATE],
    ['the first setup', PinModal, { ...BASE_GATE, isFirstSetup: true }],
    ['the PIN change', ChangePinModal, BASE_CHANGE],
    ['the PIN recovery', ChangePinModal, { ...BASE_CHANGE, variant: 'recover' }],
  ] as const) {
    it(`${name}: every password input is a one-time-code and no username candidate exists`, () => {
      render(component, { ...base });
      const pins = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
      expect(pins.length).toBeGreaterThan(0);
      for (const pin of pins) expect(pin.getAttribute('autocomplete')).toBe('one-time-code');
      expect(document.querySelector('input[autocomplete="username"]')).toBeNull();
      expect(document.querySelector('input[name="username"]')).toBeNull();
    });
  }
});
