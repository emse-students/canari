// @vitest-environment happy-dom
/**
 * WHAT THE FORM JOINS FROM THE ACCOUNT, SAID BEFORE SENDING, AND SENT BACK (owner, 2026-11-21,
 * principle 1): an anonymous form reading the cursus from the account hides that question and says
 * exactly what goes with the answer; the page announces the fields it displayed, and a form changed
 * since (an organiser ticked a box on a live form) is refused, read again with the answer kept.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

const state = vi.hoisted(() => ({
  form: {} as Record<string, unknown>,
  getForm: 0,
  submitted: [] as Record<string, unknown>[],
  submit: undefined as undefined | ((payload: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
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
  getForm: () => {
    state.getForm += 1;
    return Promise.resolve({ ...state.form });
  },
  checkSubmission: () =>
    Promise.resolve({
      hasSubmitted: false,
      formFull: false,
      pricing: null,
      cursusSlices: [{ pricing: null, productGridPrices: {} }],
      hiddenItemIds: [],
      maySubmit: true,
    }),
  getSubmission: () => Promise.resolve(null),
  getMyEditableAnswers: () => Promise.resolve([]),
  submitForm: (_id: string, payload: Record<string, unknown>) => {
    state.submitted.push(payload);
    return state.submit!(payload);
  },
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  state.getForm = 0;
  state.submitted = [];
  state.submit = () => Promise.resolve({ id: 's1' });
  state.form = {
    id: 'f1',
    title: 'Sondage',
    description: '',
    items: [{ id: 'q1', label: 'q1', required: false, type: 'text' }],
    currency: 'eur',
    basePrice: 0,
    allowCashPayment: false,
    isPublic: false,
    anonymous: false,
    respondentFields: [],
    guestFields: null,
  };
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

const send = () =>
  [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(m.form_view_submit())
  ) as HTMLElement | undefined;
const notice = () =>
  document.querySelector('[data-testid="respondent-notice"]')?.textContent?.replace(/\s+/g, ' ');

describe('an anonymous form that reads the cursus from the account', () => {
  it('hides the cursus question, keeps the others, and names exactly what goes with the answer', async () => {
    state.form = {
      ...state.form,
      anonymous: true,
      respondentFields: ['cursus'],
      guestFields: ['cursus', 'status'],
    };
    await render();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain(m.form_respondent_formation_label());
    expect(text).toContain(m.form_respondent_field_status());
    expect(notice()?.trim()).toBe(
      m.form_respondent_notice_anonymous_mixed({
        fields: m.form_respondent_field_cursus(),
        declared: m.form_respondent_field_status(),
      })
    );
    expect(notice()).not.toContain('seule');
  });

  it('draws the plain anonymous notice when nothing else is asked', async () => {
    state.form = {
      ...state.form,
      anonymous: true,
      respondentFields: ['cursus'],
      guestFields: ['cursus'],
    };
    await render();
    expect(document.body.textContent).not.toContain(m.form_respondent_formation_label());
    expect(notice()?.trim()).toBe(
      m.form_respondent_notice_anonymous({ fields: m.form_respondent_field_cursus() })
    );
  });

  it('still asks the cursus when the form does not read it from the account', async () => {
    state.form = {
      ...state.form,
      anonymous: true,
      respondentFields: [],
      guestFields: ['cursus'],
    };
    await render();
    expect(document.body.textContent).toContain(m.form_respondent_formation_label());
    expect(notice()).toBeUndefined();
  });
});

describe('a form that changed what it joins after the page loaded', () => {
  it('announces what it displayed, is refused, reads the form again and sends what the new notice says', async () => {
    state.form = { ...state.form, respondentFields: ['lastName'] };
    await render();
    expect(notice()).toContain(m.form_guest_identity_last_name());
    // An organiser ticks "Campus" on the live form while the member reads it.
    state.form = { ...state.form, respondentFields: ['lastName', 'campus'] };
    state.submit = () =>
      Promise.reject(new ApiRefusalError(400, 'FORM_RESPONDENT_FIELDS_CHANGED', 'changed'));
    send()!.click();
    await settle();
    expect(state.submitted[0].announcedFields).toEqual(['lastName']);
    expect(state.getForm).toBe(2);
    expect(document.body.textContent).toContain(m.form_refusal_respondent_fields_changed());
    expect(notice()).toContain(m.form_respondent_field_campus());
    // The member reads the new notice and sends again: it announces the fields now displayed.
    state.submit = () => Promise.resolve({ id: 's1' });
    send()!.click();
    await settle();
    expect(state.submitted[1].announcedFields).toEqual(['lastName', 'campus']);
  });
});
