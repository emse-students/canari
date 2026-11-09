// @vitest-environment happy-dom
/**
 * "Demander aux invités : Nom / Prénom / E-mail" (owner, 2026-11-06): three boxes, off by default,
 * drawn only on a public form, with advice that is firmer on a form that charges.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import GuestIdentitySettings from './GuestIdentitySettings.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(props: { isPublic: boolean; anonymous?: boolean; charges?: boolean }) {
  const state = $state({ guestFields: [] as string[] });
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(GuestIdentitySettings, {
    target,
    props: {
      get guestFields() {
        return state.guestFields;
      },
      set guestFields(v: string[]) {
        state.guestFields = v;
      },
      isPublic: props.isPublic,
      anonymous: props.anonymous ?? false,
      charges: props.charges ?? false,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return { target, state };
}

const boxes = (target: HTMLElement) => [...target.querySelectorAll<HTMLButtonElement>('button')];

describe('GuestIdentitySettings', () => {
  it('draws nothing on a form that is not public', () => {
    const { target } = render({ isPublic: false });
    expect(target.querySelector('[data-testid="guest-identity-settings"]')).toBeNull();
  });

  it('offers three boxes, all off, and ticks them independently', () => {
    const { target, state } = render({ isPublic: true });
    const [last, first, email] = boxes(target);
    expect(boxes(target).map((b) => b.textContent?.trim())).toEqual([
      m.form_guest_identity_last_name(),
      m.form_guest_identity_first_name(),
      m.form_guest_identity_email(),
    ]);
    expect(boxes(target).every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    email.click();
    flushSync();
    last.click();
    flushSync();
    expect(state.guestFields).toEqual(['email', 'lastName']);
    expect(first.getAttribute('aria-pressed')).toBe('false');
  });

  it('suggests them on a free public form, and firmly on a paid one, until one is ticked', () => {
    const free = render({ isPublic: true });
    expect(free.target.textContent).toContain(m.form_guest_identity_advice());
    const paid = render({ isPublic: true, charges: true });
    expect(paid.target.textContent).toContain(m.form_guest_identity_advice_paid());
    boxes(paid.target)[0].click();
    flushSync();
    expect(paid.target.querySelector('[data-testid="guest-identity-advice"]')).toBeNull();
  });

  it('offers none on an anonymous form, and says why', () => {
    const { target } = render({ isPublic: true, anonymous: true });
    expect(boxes(target)).toHaveLength(0);
    expect(target.textContent).toContain(m.form_guest_identity_blocked_anonymous());
  });
});
