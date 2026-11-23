// @vitest-environment happy-dom
/** The non-blocking "already transmitted" warning under a question that repeats an identity field. */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import Harness from './FormQuestionsSectionIdentityHarness.test.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const questions = () => [
  { id: 'q1', type: 'short_text', label: 'Nom', required: true },
  { id: 'q2', type: 'short_text', label: 'Prénom' },
  { id: 'q3', type: 'short_text', label: 'Promo' },
];

function render(anonymous = false) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const c = mount(Harness, { target, props: { initial: questions(), anonymous } });
  mounted.push(() => unmount(c));
  flushSync();
  return target;
}
const warnings = (t: HTMLElement) =>
  [...t.querySelectorAll('[data-testid="identity-duplicate-warning"]')].map((e) => e.textContent);

describe('identity duplicate warning', () => {
  it('warns under the questions the form already transmits, and only those', () => {
    const w = warnings(render());
    expect(w.length).toBe(2);
    expect(w[0]).toContain(m.form_question_duplicates_identity({ field: 'Nom' }));
    expect(w[1]).toContain(m.form_question_duplicates_identity({ field: 'Prénom' }));
  });

  it('follows the live ticks', () => {
    const t = render();
    t.querySelector<HTMLButtonElement>('[aria-label="untick-last-name"]')!.click();
    flushSync();
    const w = warnings(t);
    expect(w.length).toBe(1);
    expect(w[0]).toContain('Prénom');
  });

  it('an anonymous form transmits no name, so nothing is flagged', () => {
    expect(warnings(render(true)).length).toBe(0);
  });
});
