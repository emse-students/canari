// @vitest-environment happy-dom
/**
 * The editor's alert for a roster that failed to load: it names the association and offers a retry
 * of its own, so a failure is never shown as an empty association.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import RosterLoadAlert from './RosterLoadAlert.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(props: {
  missing: { id: string; name: string; loading: boolean }[];
  unlisted: number;
  onRetry: (id: string) => void;
}) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(RosterLoadAlert, { target, props });
  flushSync();
  mounted.push(() => unmount(instance));
  return target;
}

it('names each association whose roster failed, and its retry reloads that one', () => {
  const onRetry = vi.fn();
  const target = render({
    missing: [{ id: 'a2', name: 'Club Two', loading: false }],
    unlisted: 0,
    onRetry,
  });
  const row = target.querySelector('[data-roster-failed="a2"]')!;
  expect(row.textContent).toContain('Club Two');
  row.querySelector('button')!.click();
  expect(onRetry).toHaveBeenCalledWith('a2');
  expect(target.querySelector('[role="alert"]')).not.toBeNull();
});

it('disables the retry while it runs', () => {
  const target = render({
    missing: [{ id: 'a2', name: 'Club Two', loading: true }],
    unlisted: 0,
    onRetry: vi.fn(),
  });
  expect(
    target.querySelector<HTMLButtonElement>('[data-roster-failed="a2"] button')!.disabled
  ).toBe(true);
});

it('says how many shown associations could not be read', () => {
  const target = render({ missing: [], unlisted: 2, onRetry: vi.fn() });
  expect(target.querySelector('[data-roster-failed]')).toBeNull();
  expect(target.textContent).toMatch(/2/);
});
