// @vitest-environment happy-dom
/**
 * THE MAIL SIGN-IN: the password and nothing else to type (owner, 2026-11-27). The address is shown,
 * never a field; before the school address reached Canari the screen explains, with no field at all;
 * a refused password is said in the reader's words, under the field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { MailError } from '$lib/mail/mailErrors';
import { mailErrorText } from '$lib/mail/mailErrorText';
import MailSignIn from './MailSignIn.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

type SignInProps = ComponentProps<typeof MailSignIn>;

function render(props: Pick<SignInProps, 'address'> & Partial<SignInProps>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MailSignIn, {
    target,
    props: {
      reason: null,
      onSignIn: vi.fn(async () => {}),
      onActivate: vi.fn(async () => {}),
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

/** Every field a reader could type text into. */
function textFields(root: HTMLElement): HTMLInputElement[] {
  return [...root.querySelectorAll('input')].filter((i) => i.type !== 'checkbox');
}

describe('MailSignIn', () => {
  it('shows the address and asks only for the password, "remember" ticked by default', () => {
    const root = render({ address: 'camille.martin@etu.example.test' });
    expect(root.querySelector('[data-mail-address]')?.textContent).toBe(
      'camille.martin@etu.example.test'
    );
    expect(textFields(root).map((i) => i.type)).toEqual(['password']);
    const remember = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(remember.checked).toBe(true);
  });

  it('before the address reached Canari: an explanation, and no field at all', () => {
    const root = render({ address: null });
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelectorAll('input')).toHaveLength(0);
    const status = root.querySelector('[role="status"]');
    expect(status?.textContent).toBe(mailErrorText('address_unknown'));
    expect(root.textContent).toContain(m.mail_signin_intro_pending());
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('"Activer le mail" runs the MiConnect sign-in again (the decided product rule)', () => {
    const onActivate = vi.fn(async () => {});
    const root = render({ address: null, onActivate });
    const button = root.querySelector<HTMLButtonElement>('[data-mail-activate]')!;
    expect(button.textContent?.trim()).toBe(m.mail_activate());
    button.click();
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('a refused password is said under the field, and the password is passed with the choice', async () => {
    const onSignIn = vi.fn(async () => {
      throw new MailError('bad_credentials', 'account.AUTH_FAILED');
    });
    const root = render({ address: 'camille.martin@etu.example.test', onSignIn });
    const field = textFields(root)[0];
    field.value = 'not-it';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    flushSync();
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    await tick();
    flushSync();
    expect(onSignIn).toHaveBeenCalledWith('not-it', false);
    expect(root.textContent).toContain(mailErrorText('bad_credentials'));
  });
});
