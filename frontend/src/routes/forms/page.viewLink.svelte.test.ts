// @vitest-environment happy-dom
/**
 * "VOIR LE FORMULAIRE" ON A ROW OF THE LIST (owner, 2026-11-08): a new tab, `noopener`, the live page
 * for a published form and a PREVIEW for a draft - and a draft offers no link or QR to hand out.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  getForms: vi.fn(async () => [
    { id: 'f1', title: 'Gala', items: [], associationName: null, status: 'published' },
    { id: 'f2', title: 'Rallye', items: [], associationName: null, status: 'draft' },
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

it('opens the live page or the preview in a new tab, and badges the draft', async () => {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() => expect(target.querySelector('#form-f2')).not.toBeNull());

  const link = (id: string) =>
    target.querySelector<HTMLAnchorElement>(`#form-${id} [data-testid="form-view-link"]`)!;
  expect(link('f1').getAttribute('href')).toBe('/forms/f1');
  expect(link('f2').getAttribute('href')).toBe('/forms/f2?preview=1');
  for (const id of ['f1', 'f2']) {
    expect(link(id).getAttribute('target')).toBe('_blank');
    expect(link(id).getAttribute('rel')).toBe('noopener');
  }
  expect(target.querySelector('#form-f2 [data-testid="form-draft-badge"]')).not.toBeNull();
  expect(target.querySelector('#form-f1 [data-testid="form-draft-badge"]')).toBeNull();
});
