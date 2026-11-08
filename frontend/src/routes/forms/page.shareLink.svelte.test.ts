// @vitest-environment happy-dom
/**
 * THE FORMS LIST HANDS OUT THE ADDRESS A VISITOR CAN OPEN. A public form (`isPublic`) is shared by
 * its guest page `/f/<id>`; a member-only form by `/forms/<id>`, which sends a signed-out person to
 * the login screen. The share button and the QR code read the same path.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  getForms: vi.fn(async () => [
    { id: 'pub', title: 'Gala', items: [], associationName: null, isPublic: true },
    { id: 'mem', title: 'Rallye', items: [], associationName: null, isPublic: false },
  ]),
  getSubmissions: vi.fn(async () => []),
  exportLabels: vi.fn(),
  exportSubmissions: vi.fn(),
  deleteForm: vi.fn(),
  deleteSubmission: vi.fn(),
}));
const copy = vi.hoisted(() => ({ copyPublicShareLink: vi.fn(async () => ({ ok: true })) }));

vi.mock('$lib/forms/api', () => api);
vi.mock('$lib/utils/copyShareLink', () => copy);
vi.mock('$app/state', () => ({ page: { url: new URL('https://canari.test/forms'), state: {} } }));

import Page from './+page.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function shareButtonOf(id: string): Promise<HTMLButtonElement> {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() => expect(target.querySelector(`#form-${id}`)).not.toBeNull());
  const row = target.querySelector(`#form-${id}`)!;
  return row.querySelector(`button[title="${m.form_list_share_button()}"]`)!;
}

it('copies the guest address of a public form', async () => {
  (await shareButtonOf('pub')).click();
  expect(copy.copyPublicShareLink).toHaveBeenCalledWith('/f/pub');
});

it('copies the member address of a form that is not public', async () => {
  (await shareButtonOf('mem')).click();
  expect(copy.copyPublicShareLink).toHaveBeenCalledWith('/forms/mem');
});
