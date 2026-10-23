// @vitest-environment happy-dom
/**
 * A LINK NAMING ONE FORM'S RESPONSES (`/forms?responses=<id>`, the organiser alert for a payment
 * over capacity) opens that form's accordion on the list once it has loaded - and a link naming a
 * form the list does not hold says so in the log and opens nothing.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const url = vi.hoisted(() => ({ value: new URL('https://canari.test/forms') }));
const api = vi.hoisted(() => ({
  getForms: vi.fn(async () => [
    { id: 'f1', title: 'Gala', items: [], associationName: null },
    { id: 'f2', title: 'Rallye', items: [], associationName: null },
  ]),
  getSubmissions: vi.fn(async () => []),
  exportLabels: vi.fn(),
  exportSubmissions: vi.fn(),
  deleteForm: vi.fn(),
  deleteSubmission: vi.fn(),
}));

vi.mock('$lib/forms/api', () => api);
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return url.value;
    },
    state: {},
  },
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  return target;
}

it("opens the named form's responses, and only that form's", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  url.value = new URL('https://canari.test/forms?responses=f2');
  render();
  await vi.waitFor(() => expect(api.getSubmissions).toHaveBeenCalledWith('f2'));
  expect(api.getSubmissions).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
});

it('opens nothing without the parameter', async () => {
  url.value = new URL('https://canari.test/forms');
  const target = render();
  await vi.waitFor(() => expect(target.querySelector('#form-f1')).not.toBeNull());
  expect(api.getSubmissions).not.toHaveBeenCalled();
});

it('says in the log that the named form is not on the list, and opens nothing', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  url.value = new URL('https://canari.test/forms?responses=gone');
  render();
  await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.stringContaining('gone')));
  expect(api.getSubmissions).not.toHaveBeenCalled();
});
