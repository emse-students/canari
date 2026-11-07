// @vitest-environment happy-dom
/**
 * "VOS COORDONNÉES" ON A PUBLIC FORM (owner, 2026-11-06): a guest is asked nothing by default, every
 * field the creator ticked is required, and the e-mail - when asked - is the one Lydia's request goes
 * to: the payment step does not ask for it a second time.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { PublicForm } from '$lib/forms/api';

const api = vi.hoisted(() => ({ get: vi.fn(), submit: vi.fn() }));
const nav = vi.hoisted(() => ({ external: vi.fn() }));

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
vi.mock('$lib/utils/openExternal', () => ({ navigateExternal: nav.external }));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  api.get.mockReset();
  api.submit.mockReset();
  nav.external.mockReset();
});

const form = (over: Partial<PublicForm> = {}): PublicForm =>
  ({
    id: 'f1',
    title: 'Soirée',
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
    guestFields: [],
    ...over,
  }) as PublicForm;

async function render(served: PublicForm) {
  api.get.mockResolvedValue(served);
  api.submit.mockResolvedValue({ ok: true, checkoutUrl: 'https://lydia.example/pay/1' });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const target = document.body.appendChild(document.createElement('div'));
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
  return target;
}

const block = () => document.querySelector('[data-testid="guest-identity-fields"]');
const field = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="guest-${name}"]`)!;
function type(name: string, value: string) {
  const input = field(name);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  flushSync();
}
async function send() {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.includes(m.form_view_submit()) || b.textContent?.includes('12')
  )!;
  button.click();
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
}

describe('the guest identity block', () => {
  it('asks nothing when the form asks nothing, and sends no identity', async () => {
    await render(form());
    expect(block()).toBeNull();
    await send();
    expect(api.submit).toHaveBeenCalledTimes(1);
    const body = api.submit.mock.calls[0][1];
    expect(body).not.toHaveProperty('guestLastName');
    expect(body).not.toHaveProperty('guestEmail');
  });

  it('draws only the asked fields, and holds the send until they are filled', async () => {
    await render(form({ guestFields: ['lastName', 'firstName'] }));
    expect(block()?.textContent).toContain(m.form_guest_identity_title());
    expect(field('lastName')).not.toBeNull();
    expect(field('email')).toBeNull();

    await send();
    expect(api.submit).not.toHaveBeenCalled();
    expect(block()?.textContent).toContain(m.form_guest_identity_required());

    type('lastName', ' Curie ');
    type('firstName', 'Marie');
    await send();
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.submit.mock.calls[0][1]).toMatchObject({
      guestLastName: 'Curie',
      guestFirstName: 'Marie',
    });
    expect(api.submit.mock.calls[0][1]).not.toHaveProperty('guestEmail');
  });

  it('pays online to the asked e-mail without asking for it again', async () => {
    await render(form({ guestFields: ['email'], basePrice: 1200 }));
    expect(document.querySelector('[data-testid="guest-email-lydia-note"]')?.textContent).toBe(
      m.form_guest_identity_email_lydia_note()
    );
    type('email', 'marie@x.fr');
    await send();
    // No second prompt: the request goes out with the one address typed.
    expect(document.body.textContent).not.toContain(m.payer_email_title());
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.submit.mock.calls[0][1]).toMatchObject({ guestEmail: 'marie@x.fr' });
    expect(api.submit.mock.calls[0][1]).not.toHaveProperty('payerEmail');
    expect(document.body.textContent).toContain(m.form_guest_payment_note_email_kept());
  });

  it('asks the payer address at the payment step when the form did not ask the e-mail', async () => {
    await render(form({ basePrice: 1200 }));
    await send();
    expect(api.submit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(m.payer_email_title());
  });
});
