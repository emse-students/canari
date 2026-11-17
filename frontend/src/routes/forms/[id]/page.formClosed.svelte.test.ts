// @vitest-environment happy-dom
/**
 * A FORM A MANAGER ENDED (#3719, read on the Mi 9T 2026-11-17): the member page used to draw it open
 * and refuse only at "Envoyer" (400 FORM_CLOSED). It now reads the SAME rule as the public page and
 * the manager's list (`isClosedForm`): the closed notice, no send button, the questions locked. An
 * end still to come is a scheduled close, not a closed form.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

const state = vi.hoisted(() => ({
  closedAt: null as string | null,
  windowState: undefined as string | undefined,
  hasSubmitted: false,
  submit: undefined as undefined | (() => Promise<unknown>),
  edit: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverFormAnswerEdit: () => true,
}));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/posts/useFormReminder.svelte', () => ({
  useFormReminder: () => ({ load: () => Promise.resolve(), active: false }),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  getCalendarEventLinkedToForm: () => Promise.resolve({ linkedEvent: null }),
  getAssociation: () => Promise.reject(new Error('unused')),
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Sondage',
      description: '',
      items: [{ id: 'q1', label: 'q1', required: false, type: 'text' }],
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
      closedAt: state.closedAt,
      windowState: state.windowState,
      allowAnswerEdit: true,
    }),
  checkSubmission: () =>
    Promise.resolve({
      hasSubmitted: state.hasSubmitted,
      formFull: false,
      pricing: null,
      cursusSlices: [{ pricing: null, productGridPrices: {} }],
      hiddenItemIds: [],
      maySubmit: true,
    }),
  getSubmission: () => Promise.resolve(null),
  getMyEditableAnswers: () =>
    Promise.resolve(
      state.hasSubmitted
        ? [
            {
              id: 's1',
              formId: 'f1',
              answers: {},
              totalPaid: 0,
              paymentStatus: 'none',
              createdAt: '2026-11-01T10:00:00Z',
              lockedItemIds: [],
            },
          ]
        : []
    ),
  submitForm: () => state.submit!(),
  editFormAnswer: () => state.edit!(),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await settle();
}

const sendButton = () =>
  [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(m.form_view_submit())
  );

const notice = () => document.querySelector('[data-testid="form-closed-notice"]');
const refused = (code: string) => new ApiRefusalError(400, code, 'refused');
const press = async (el: Element | undefined) => {
  (el as HTMLElement).click();
  await settle();
};

beforeEach(() => {
  state.closedAt = null;
  state.windowState = undefined;
  state.hasSubmitted = false;
});

describe('the member form page and a form ended by hand', () => {
  it('draws the closed notice and locks the send when the server says closed', async () => {
    state.closedAt = '2026-01-01T00:00:00.000Z';
    state.windowState = 'closed';
    await render();
    expect(notice()?.textContent).toContain(m.form_view_closed());
    const send = sendButton();
    expect(send === undefined || send.hasAttribute('disabled')).toBe(true);
  });

  it('reads closed from the SERVER state on a phone whose clock is behind (the refetch)', async () => {
    // The stored end is still ahead of this device's clock; the server has judged it closed.
    state.closedAt = '2099-01-01T00:00:00.000Z';
    state.windowState = 'closed';
    await render();
    expect(notice()).not.toBeNull();
  });

  it('draws the form open when the server says open, whatever the stored end says', async () => {
    state.closedAt = '2020-01-01T00:00:00.000Z';
    state.windowState = 'open';
    await render();
    expect(notice()).toBeNull();
    expect(sendButton()?.hasAttribute('disabled')).toBe(false);
  });

  it('falls back to the comparison on a server that sends no state, both ways', async () => {
    // Without the fallback a missing state reads open: the past end must close it, the future end must not.
    state.closedAt = '2026-01-01T00:00:00.000Z';
    await render();
    expect(notice()).not.toBeNull();
    expect(sendButton()?.hasAttribute('disabled') ?? true).toBe(true);
    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    state.closedAt = '2099-01-01T00:00:00.000Z';
    await render();
    expect(notice()).toBeNull();
    expect(sendButton()?.hasAttribute('disabled')).toBe(false);
  });

  it('draws the form open with no end, and the send really is live', async () => {
    state.windowState = 'open';
    await render();
    expect(notice()).toBeNull();
    expect(sendButton()?.hasAttribute('disabled')).toBe(false);
    // The server state is what disables it: the same page told closed has the send off.
    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    state.windowState = 'closed';
    await render();
    expect(sendButton()?.hasAttribute('disabled') ?? true).toBe(true);
  });

  it('redraws not-yet, with no opening date to show, when a send is refused FORM_NOT_OPEN_YET', async () => {
    state.windowState = 'open';
    state.submit = () => Promise.reject(refused('FORM_NOT_OPEN_YET'));
    await render();
    await press(sendButton());
    expect(document.querySelector('[data-testid="form-not-open-notice"]')?.textContent).toContain(
      m.form_view_not_open_yet()
    );
    expect(sendButton()?.hasAttribute('disabled')).toBe(true);
  });

  it('redraws closed when a send is refused FORM_CLOSED while the page is open', async () => {
    state.windowState = 'open';
    state.submit = () => Promise.reject(refused('FORM_CLOSED'));
    await render();
    expect(notice()).toBeNull();
    await press(sendButton());
    expect(notice()?.textContent).toContain(m.form_view_closed());
    expect(sendButton()?.hasAttribute('disabled')).toBe(true);
  });

  it('redraws closed when a changed answer is refused FORM_CLOSED', async () => {
    state.windowState = 'open';
    state.hasSubmitted = true;
    state.edit = () => Promise.reject(refused('FORM_CLOSED'));
    await render();
    await press(document.querySelector('[data-testid="form-edit-open"]')!);
    const save = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes(m.form_view_edit_save())
    );
    await press(save);
    expect(notice()).not.toBeNull();
  });

  it('refuses a changed answer on a form already closed, with no request', async () => {
    state.windowState = 'closed';
    state.hasSubmitted = true;
    state.edit = vi.fn(() => Promise.resolve({}));
    await render();
    const open = document.querySelector('[data-testid="form-edit-open"]');
    if (open) {
      await press(open);
      const save = [...document.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes(m.form_view_edit_save())
      );
      if (save && !save.hasAttribute('disabled')) await press(save);
    }
    expect(state.edit).not.toHaveBeenCalled();
  });
});
