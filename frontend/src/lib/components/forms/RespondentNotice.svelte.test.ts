// @vitest-environment happy-dom
/**
 * THE RESPONDENT IS TOLD, BEFORE SENDING, WHAT REACHES THE ORGANISER (owner, 2026-11-16): the
 * account fields a named form joins are listed above the send button; a form joining nothing, and
 * an anonymous form (served none), draw nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import RespondentNotice from './RespondentNotice.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(respondentFields: string[] | undefined, anonymous = false) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(RespondentNotice, { target, props: { respondentFields, anonymous } });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

describe('RespondentNotice', () => {
  it('lists the fields the form joins, in the editor order', () => {
    const target = render(['campus', 'lastName', 'cursus']);
    expect(target.querySelector('[data-testid="respondent-notice"]')?.textContent?.trim()).toBe(
      m.form_respondent_notice({
        fields: [
          m.form_guest_identity_last_name(),
          m.form_respondent_field_cursus(),
          m.form_respondent_field_campus(),
        ].join(', '),
      })
    );
  });

  it('says an anonymous form stays anonymous while it reads the cursus from the account', () => {
    const target = render(['cursus'], true);
    expect(target.querySelector('[data-testid="respondent-notice"]')?.textContent?.trim()).toBe(
      m.form_respondent_notice_anonymous({ fields: m.form_respondent_field_cursus() })
    );
  });

  it('draws nothing when the form joins nothing, or the server is older than the choice', () => {
    expect(render([]).querySelector('[data-testid="respondent-notice"]')).toBeNull();
    expect(render(undefined).querySelector('[data-testid="respondent-notice"]')).toBeNull();
  });
});
