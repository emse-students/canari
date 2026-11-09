// @vitest-environment happy-dom
/**
 * A FORM CARD'S ACTIONS ARE ONE ROW (owner, 2026-11-08): seven icon buttons wrapped, the last one
 * alone on a second line, on a phone. happy-dom has no layout, so the test pins what makes one row:
 * a single non-wrapping flex container holding every action, each named for a screen reader. And
 * the card's one-line excerpt is plain text, not the markdown the description was written in.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  getForms: vi.fn(async () => [
    {
      id: 'f1',
      title: 'Census',
      description: '**Ce formulaire est un recensement** de [la liste](https://example.test).',
      items: [],
      associationName: 'Asso',
      status: 'published',
    },
    { id: 'f2', title: 'Draft', items: [], associationName: null, status: 'draft' },
  ]),
  getSubmissions: vi.fn(async () => []),
  exportLabels: vi.fn(),
  exportSubmissions: vi.fn(),
  deleteForm: vi.fn(),
  deleteSubmission: vi.fn(),
}));
vi.mock('$lib/forms/api', () => api);
vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/forms'), state: {} },
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() => expect(target.querySelector('#form-f2')).not.toBeNull());
  return target;
}

/** The container of a card's actions: the parent of its "view" link. */
const actionsOf = (target: HTMLElement, id: string) =>
  target.querySelector(`#form-${id} [data-testid="form-view-link"]`)!.parentElement!;

it('keeps every action of a published form on one non-wrapping row, each one named', async () => {
  const target = await render();
  const row = actionsOf(target, 'f1');
  expect(row.className).toContain('flex');
  expect(row.className).not.toContain('flex-wrap');
  // edit, view, link, QR, export, responses, delete
  expect(row.children).toHaveLength(7);
  for (const el of row.querySelectorAll('a, button')) {
    expect(el.getAttribute('aria-label')?.length).toBeGreaterThan(0);
  }
});

it('keeps a draft on one row too, without the link and QR it cannot hand out', async () => {
  const target = await render();
  const row = actionsOf(target, 'f2');
  expect(row.className).not.toContain('flex-wrap');
  expect(row.children).toHaveLength(5);
});

it('shows the description as plain text, without markdown markers', async () => {
  const target = await render();
  const excerpt = target.querySelector('#form-f1 p')!.textContent!.trim();
  expect(excerpt).toBe('Ce formulaire est un recensement de la liste.');
});
