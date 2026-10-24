// @vitest-environment happy-dom
/**
 * A PINNED TOAST HAS NO CLOSE BUTTON. It is shown by a page that no longer saves anything
 * (`BaseMlsService.tellMemberThisPageEnded`), and closed it would leave that page looking alive.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

import ToastContainer from './ToastContainer.svelte';
import { toastStore, dismissToast, showToast, showPinnedToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  for (const t of toastStore.toasts) dismissToast(t.id);
  document.body.innerHTML = '';
});

function render(): HTMLElement {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(ToastContainer, { target });
  mounted.push(() => unmount(instance));
  return target;
}

const closeButtons = (target: HTMLElement) =>
  target.querySelectorAll(`button[aria-label="${m.common_close_label()}"]`);

it('an ordinary toast can be closed', () => {
  const target = render();
  showToast('plain', 'info');
  flushSync();
  expect(closeButtons(target)).toHaveLength(1);
});

it('a pinned toast has no close button, only its action', () => {
  const target = render();
  const run = vi.fn();
  showPinnedToast('pinned', 'error', { label: 'Reload', run });
  flushSync();
  expect(closeButtons(target)).toHaveLength(0);
  const action = [...target.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Reload'
  );
  expect(action).toBeDefined();
  action!.click();
  expect(run).toHaveBeenCalledTimes(1);
});
