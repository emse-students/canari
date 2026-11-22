// @vitest-environment happy-dom
/**
 * "Qui a repondu" (owner, 2026-11-16, built on "Demander aux invites" of 2026-11-06): ONE set of
 * boxes on every form - the names, the e-mail on a public form, "Promo et formation", "Statut",
 * "Campus" - ticked independently; an anonymous form offers no name nor e-mail; the advice to tell
 * guests apart is firmer on a public form that charges.
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

function render(props: {
  isPublic: boolean;
  anonymous?: boolean;
  charges?: boolean;
  choices?: string[];
}) {
  const state = $state({ choices: props.choices ?? ([] as string[]) });
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(GuestIdentitySettings, {
    target,
    props: {
      get choices() {
        return state.choices;
      },
      set choices(v: string[]) {
        state.choices = v;
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
const labels = (target: HTMLElement) => boxes(target).map((b) => b.textContent?.trim());

describe('GuestIdentitySettings', () => {
  it('offers the account fields on a named form, the e-mail aside (a member has none here)', () => {
    const { target } = render({ isPublic: false });
    expect(labels(target)).toEqual([
      m.form_guest_identity_last_name(),
      m.form_guest_identity_first_name(),
      m.form_respondent_field_cursus(),
      m.form_respondent_field_status(),
      m.form_respondent_field_campus(),
    ]);
    expect(target.textContent).toContain(m.form_respondent_settings_hint());
  });

  it('offers the e-mail too on a public form, every box ticked independently', () => {
    const { target, state } = render({ isPublic: true });
    expect(labels(target)).toContain(m.form_guest_identity_email());
    const [last, , email, cursus] = boxes(target);
    email.click();
    flushSync();
    cursus.click();
    flushSync();
    last.click();
    flushSync();
    expect(state.choices).toEqual(['email', 'cursus', 'lastName']);
  });

  it('suggests telling guests apart on a free public form, firmly on a paid one, until a name is ticked', () => {
    const free = render({ isPublic: true });
    expect(free.target.textContent).toContain(m.form_guest_identity_advice());
    const paid = render({ isPublic: true, charges: true });
    expect(paid.target.textContent).toContain(m.form_guest_identity_advice_paid());
    boxes(paid.target)[0].click();
    flushSync();
    expect(paid.target.querySelector('[data-testid="guest-identity-advice"]')).toBeNull();
  });

  it('offers no name nor e-mail on an anonymous form, only what is declared, and says so', () => {
    const { target } = render({ isPublic: true, anonymous: true });
    expect(labels(target)).toEqual([
      m.form_respondent_field_cursus(),
      m.form_respondent_field_status(),
      m.form_respondent_field_campus(),
      m.form_respondent_field_cursus_from_account(),
    ]);
    expect(target.textContent).toContain(m.form_respondent_settings_hint_anonymous());
  });

  it('warns about small groups once the cursus is read from the account, and says it ticks the cursus', () => {
    const joined = render({
      isPublic: false,
      anonymous: true,
      choices: ['cursus', 'cursusFromAccount'],
    });
    const note = joined.target.querySelector('[data-testid="cursus-from-account-note"]');
    expect(note?.textContent).toContain(m.form_respondent_cursus_from_account_note());
    expect(note?.textContent).toContain(m.form_respondent_cursus_from_account_ticks_cursus());
    const off = render({ isPublic: false, anonymous: true, choices: ['cursus'] });
    expect(off.target.querySelector('[data-testid="cursus-from-account-note"]')).toBeNull();
  });

  it('ticks "Promo et formation" with the account reading, and unticks the reading with it', () => {
    const { target, state } = render({ isPublic: false, anonymous: true });
    const [cursus, , , fromAccount] = boxes(target);
    fromAccount.click();
    flushSync();
    expect(state.choices).toEqual(['cursusFromAccount', 'cursus']);
    expect(cursus.getAttribute('aria-pressed')).toBe('true');
    cursus.click();
    flushSync();
    expect(state.choices).toEqual([]);
  });
});
