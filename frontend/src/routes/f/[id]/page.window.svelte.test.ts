// @vitest-environment happy-dom
/**
 * The public page's window comes from the SERVER (`windowState`), never from this device's clock
 * against `opensAt` / `closedAt`; a typed refusal while the page is open redraws it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { PublicForm } from '$lib/forms/api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

const api = vi.hoisted(() => ({ get: vi.fn(), submit: vi.fn() }));

vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/f/f1'), params: { id: 'f1' }, state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/user')>()),
  currentUserId: () => null,
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getPublicForm: api.get,
  submitPublicForm: api.submit,
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  api.get.mockReset();
  api.submit.mockReset();
});

const form = (over: Partial<PublicForm> = {}): PublicForm =>
  ({
    id: 'f1',
    title: 'Soiree',
    description: '',
    imageUrl: null,
    items: [],
    opensAt: undefined,
    closedAt: null,
    anonymous: false,
    basePrice: 0,
    currency: 'eur',
    allowCashPayment: false,
    paymentsPaused: false,
    formFull: false,
    pricing: null,
    cursusSlices: [{ pricing: null, productGridPrices: {} }],
    guestFields: [],
    ...over,
  }) as PublicForm;

async function settle() {
  for (let i = 0; i < 6; i++) await tick();
  flushSync();
}
async function render(served: PublicForm) {
  api.get.mockResolvedValue(served);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const app = mount(Page, { target: document.body.appendChild(document.createElement('div')) });
  mounted.push(() => void unmount(app));
  await settle();
}
const send = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(m.form_view_submit())
  );
const notice = () => document.querySelector('[data-testid="form-not-open-notice"]');
const text = () => document.body.textContent ?? '';

describe('the public form page and the server window state', () => {
  it('does not call a form opening later what the server calls open (a phone behind)', async () => {
    await render(form({ opensAt: '2099-01-01T00:00:00.000Z', windowState: 'open' }));
    expect(notice()).toBeNull();
    expect(send()?.hasAttribute('disabled')).toBe(false);
  });

  it('draws the opening notice when the server says not-yet', async () => {
    await render(form({ opensAt: '2099-01-01T00:00:00.000Z', windowState: 'not-yet' }));
    expect(notice()).not.toBeNull();
    expect(send()?.hasAttribute('disabled')).toBe(true);
  });

  it('draws closed from the server state with an end still ahead of this clock', async () => {
    await render(form({ closedAt: '2099-01-01T00:00:00.000Z', windowState: 'closed' }));
    expect(text()).toContain(m.form_view_closed());
    expect(send()?.hasAttribute('disabled')).toBe(true);
  });

  it('redraws closed when a send is refused FORM_CLOSED while the page is open', async () => {
    await render(form({ windowState: 'open' }));
    expect(text()).not.toContain(m.form_view_closed());
    api.submit.mockRejectedValueOnce(new ApiRefusalError(400, 'FORM_CLOSED', 'x'));
    send()!.click();
    await settle();
    expect(text()).toContain(m.form_view_closed());
    expect(send()?.hasAttribute('disabled')).toBe(true);
  });

  it('redraws not-yet, with no date to show, on FORM_NOT_OPEN_YET', async () => {
    await render(form({ windowState: 'open' }));
    api.submit.mockRejectedValueOnce(new ApiRefusalError(400, 'FORM_NOT_OPEN_YET', 'x'));
    send()!.click();
    await settle();
    expect(notice()?.textContent).toContain(m.form_view_not_open_yet());
    expect(send()?.hasAttribute('disabled')).toBe(true);
  });
});
