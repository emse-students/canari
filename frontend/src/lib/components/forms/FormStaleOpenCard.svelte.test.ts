// @vitest-environment happy-dom
/**
 * The question put to a form left open (owner, 2026-11-21): "Ce formulaire est toujours ouvert. Le
 * fermer ?" with three answers, none of them a default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FormStaleOpenCard from './FormStaleOpenCard.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(props: Record<string, unknown> = {}) {
  const handlers = { onClose: vi.fn(), onKeepOpen: vi.fn(), onSetDate: vi.fn() };
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(FormStaleOpenCard, {
    target,
    props: {
      suggestedDate: '2026-12-05T23:59',
      minDate: '2026-11-21T10:00',
      busy: false,
      ...handlers,
      ...props,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return { target, ...handlers };
}

const byId = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

describe('FormStaleOpenCard', () => {
  it("asks the question in the owner's words and offers close, keep open and set a date", () => {
    const { target } = render();
    expect(target.textContent).toContain(m.form_stale_open_title());
    expect(byId(target, 'form-stale-open-close').textContent).toContain(m.form_stale_open_close());
    expect(byId(target, 'form-stale-open-keep').textContent).toContain(m.form_stale_open_keep());
    expect(byId(target, 'form-stale-open-date').textContent).toContain(m.form_stale_open_date());
  });

  it('closes and keeps open through the parent, one tap each', () => {
    const { target, onClose, onKeepOpen } = render();
    byId(target, 'form-stale-open-close').click();
    byId(target, 'form-stale-open-keep').click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onKeepOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the date field only after "Fixer une date", starting on the suggestion', () => {
    const { target, onSetDate } = render();
    expect(target.querySelector('[data-testid="form-stale-open-picker"]')).toBeNull();
    byId(target, 'form-stale-open-date').click();
    flushSync();
    expect(target.querySelector('[data-testid="form-stale-open-picker"]')).not.toBeNull();
    byId(target, 'form-stale-open-date-confirm').click();
    expect(onSetDate).toHaveBeenCalledWith('2026-12-05T23:59');
  });

  it('is inert while an answer is being sent', () => {
    const { target } = render({ busy: true });
    for (const id of ['form-stale-open-close', 'form-stale-open-keep', 'form-stale-open-date']) {
      expect(byId(target, id).disabled).toBe(true);
    }
  });
});
