// @vitest-environment happy-dom
/**
 * A named reader's card: their campuses as chips, grouped, and a NAMED edit button.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReadGrantCard from './ReadGrantCard.svelte';
import { m } from '$lib/paraglide/messages';
import type { ReadGrant } from '$lib/associations/api';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const grant = (campus: string, formation: string | null): ReadGrant => ({
  userId: 'u1',
  campus,
  formation,
  grantedBy: 'admin',
  createdAt: '2026-10-16T10:00:00Z',
});

function render(grants: ReadGrant[]) {
  const onEdit = vi.fn();
  const target = document.body.appendChild(document.createElement('ul'));
  const instance = mount(ReadGrantCard, { target, props: { name: 'Alice', grants, onEdit } });
  flushSync();
  mounted.push(() => unmount(instance));
  return { target, onEdit };
}

it('draws one chip per scope held, grouped under its campus', () => {
  const { target } = render([
    grant('gardanne', 'ISMIN'),
    grant('saint-etienne', null),
    grant('gardanne', 'ICM'),
  ]);
  const terms = [...target.querySelectorAll('dt')].map((d) => d.textContent!.trim());
  expect(terms).toEqual([m.profile_campus_saint_etienne(), m.profile_campus_gardanne()]);
  const chips = [...target.querySelectorAll('[data-testid="read-grant-chip"]')].map((c) =>
    c.textContent!.trim()
  );
  expect(chips).toEqual([m.readaccess_whole_campus(), 'ICM', 'ISMIN']);
});

it('says so when the person holds nothing yet', () => {
  const { target } = render([]);
  expect(target.textContent).toContain(m.readaccess_no_access());
  expect(target.querySelectorAll('[data-testid="read-grant-chip"]')).toHaveLength(0);
});

it('the edit button names the person and calls onEdit', () => {
  const { target, onEdit } = render([grant('gardanne', null)]);
  const button = target.querySelector('button')!;
  expect(button.getAttribute('aria-label')).toBe(m.readaccess_edit_aria({ name: 'Alice' }));
  button.click();
  expect(onEdit).toHaveBeenCalledOnce();
});
