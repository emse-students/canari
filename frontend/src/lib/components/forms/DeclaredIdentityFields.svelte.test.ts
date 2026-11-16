// @vitest-environment happy-dom
/**
 * "A propos de vous" (owner, 2026-11-16): what a form asks INSTEAD of reading an account - a guest,
 * or any respondent of an anonymous form. Only the asked fields are drawn; on an anonymous form the
 * hint says nothing else links the answer to the account; a form asking nothing draws nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { emptyDeclaredValues, type DeclaredField } from '$lib/forms/respondentFields';
import DeclaredIdentityFields from './DeclaredIdentityFields.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(asked: DeclaredField[], anonymous: boolean) {
  const state = $state({ values: emptyDeclaredValues() });
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(DeclaredIdentityFields, {
    target,
    props: {
      asked,
      get values() {
        return state.values;
      },
      set values(v) {
        state.values = v;
      },
      showErrors: false,
      anonymous,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

describe('DeclaredIdentityFields', () => {
  it('draws only what the form asks, and says an anonymous answer stays anonymous', () => {
    const target = render(['status', 'campus'], true);
    const text = target.textContent ?? '';
    expect(text).toContain(m.form_respondent_declared_hint_anonymous());
    expect(text).toContain(m.form_respondent_field_status());
    expect(text).toContain(m.form_respondent_field_campus());
    expect(text).not.toContain(m.form_respondent_promo_label());
  });

  it('asks a formation and an entry year for the promo and formation', () => {
    const text = render(['cursus'], false).textContent ?? '';
    expect(text).toContain(m.form_respondent_declared_hint());
    expect(text).toContain(m.form_respondent_formation_label());
    expect(text).toContain(m.form_respondent_promo_label());
  });

  it('draws nothing when the form asks nothing', () => {
    expect(render([], true).querySelector('[data-testid="declared-identity-fields"]')).toBeNull();
  });
});
