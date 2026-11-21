// @vitest-environment happy-dom
/**
 * A RESPONDENT ALWAYS SEES THEIR OWN ANSWER, READ-ONLY (owner, 2026-11-21): "je voudrais pouvoir voir
 * ma reponse, meme si l'editeur m'interdit de la modifier" - forms.md, "A respondent sees their own
 * answer".
 *
 * Pinned: a named form draws the server's row read-only with the switch off, its price-fixing
 * question marked; a form taking several answers lists them, each opened to read and closed again;
 * an anonymous form already answered says "already answered" (the registry's yes, nothing of the
 * answer) instead of an empty form, and an unanswered one stays fillable; nothing of the answer is
 * kept on the device (owner, 2026-11-21); an estate older than `myAnswers` keeps the page's old read.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const state = vi.hoisted(() => ({
  form: {} as Record<string, unknown>,
  check: {} as Record<string, unknown>,
  legacySubmission: null as unknown,
  submitted: [] as Record<string, unknown>[],
}));

vi.mock('$app/state', () => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'u-own-answer',
  getSavedDisplayName: () => 'Alice',
}));
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
  getForm: () => Promise.resolve(state.form),
  checkSubmission: () => Promise.resolve(state.check),
  getSubmission: () => Promise.resolve(state.legacySubmission),
  getMyEditableAnswers: () => Promise.resolve([]),
  submitForm: (_id: string, body: Record<string, unknown>) => {
    state.submitted.push(body);
    return Promise.resolve({ submissionId: 's-new' });
  },
}));

import Page from './+page.svelte';

const ITEMS = [
  { id: 'q1', label: 'Avis', required: false, type: 'short_text' },
  {
    id: 'q2',
    label: 'Repas',
    required: false,
    type: 'single_choice',
    options: [
      { id: 'o1', label: 'Sans', priceModifier: 0 },
      { id: 'o2', label: 'Avec', priceModifier: 500 },
    ],
  },
];

function formOf(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    title: 'Sondage',
    description: '',
    items: ITEMS,
    currency: 'eur',
    basePrice: 0,
    allowCashPayment: false,
    isPublic: false,
    allowAnswerEdit: false,
    allowMultipleSubmissions: false,
    anonymous: false,
    ...over,
  };
}

function checkOf(over: Record<string, unknown> = {}) {
  return {
    hasSubmitted: false,
    formFull: false,
    pricing: null,
    cursusSlices: [{ pricing: null, productGridPrices: {} }],
    hiddenItemIds: [],
    maySubmit: true,
    ...over,
  };
}

const row = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  id,
  formId: 'f1',
  answers: { q1: text },
  totalPaid: 0,
  paymentStatus: 'free',
  createdAt: '2026-11-01T10:00:00Z',
  lockedItemIds: [],
  ...over,
});

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  state.submitted = [];
  state.legacySubmission = null;
});
afterEach(async () => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 12; i++) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await settle();
}

const textInput = () => document.querySelector<HTMLInputElement>('input[type="text"]');
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const buttonNamed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (b.textContent ?? '').includes(label)
  );

describe('a named form', () => {
  it('draws the answer read-only with the switch off, its price-fixing question marked', async () => {
    state.form = formOf({ requiresPayment: true, allowCashPayment: true });
    state.check = checkOf({
      hasSubmitted: true,
      paymentStatus: 'pending_cash',
      submissionId: 's1',
      myAnswers: [
        row('s1', 'Mon avis', { answers: { q1: 'Mon avis', q2: 'o2' }, lockedItemIds: ['q2'] }),
      ],
    });
    await render();
    expect(textInput()?.value).toBe('Mon avis');
    expect(textInput()?.disabled).toBe(true);
    expect(document.body.textContent).toContain(m.form_view_edit_locked_note());
    expect(byTestId('form-already-answered')).toBeNull();
    expect(byTestId('form-device-copy-note')).toBeNull();
  });

  it('a form taking several answers lists them; each opens to read and closes back to a blank form', async () => {
    state.form = formOf({ allowMultipleSubmissions: true });
    state.check = checkOf({ myAnswers: [row('s2', 'Deuxieme'), row('s1', 'Premiere')] });
    await render();
    expect(byTestId('form-own-answers')?.querySelectorAll('li')).toHaveLength(2);
    expect(textInput()?.disabled).toBe(false);

    document
      .querySelectorAll<HTMLButtonElement>('[data-testid="form-own-answers"] button')[1]
      .click();
    await settle();
    expect(byTestId('form-own-answer-banner')).not.toBeNull();
    expect(textInput()?.value).toBe('Premiere');
    expect(textInput()?.disabled).toBe(true);
    // Nothing is sent from a read answer.
    expect(buttonNamed(m.form_view_submit())).toBeUndefined();

    buttonNamed(m.form_view_answer_view_close())!.click();
    await settle();
    expect(byTestId('form-own-answer-banner')).toBeNull();
    expect(textInput()?.value).toBe('');
    expect(textInput()?.disabled).toBe(false);
  });

  it('an estate older than myAnswers: the single answer is read as before', async () => {
    state.form = formOf();
    state.check = checkOf({ hasSubmitted: true, paymentStatus: 'free' });
    state.legacySubmission = { answers: { q1: 'Ancien' } };
    await render();
    expect(textInput()?.value).toBe('Ancien');
    expect(textInput()?.disabled).toBe(true);
  });
});

describe('an anonymous form', () => {
  it('already answered: says so - never an empty form that looks answerable', async () => {
    state.form = formOf({ anonymous: true });
    // What the server answers: answered (the registry), and none of the answers.
    state.check = checkOf({ hasSubmitted: true, paymentStatus: 'free', myAnswers: [] });
    await render();
    const block = byTestId('form-already-answered');
    expect(block?.textContent).toContain(m.form_view_already_answered_title());
    expect(block?.textContent).toContain(m.form_view_already_answered_anonymous_note());
    expect(textInput()).toBeNull();
  });

  it('not answered yet: the form is fillable, and sending keeps nothing of the answer here', async () => {
    state.form = formOf({ anonymous: true });
    state.check = checkOf({ myAnswers: [] });
    await render();
    expect(byTestId('form-already-answered')).toBeNull();
    const input = textInput()!;
    expect(input.disabled).toBe(false);
    input.value = 'Envoye';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    const before = { ...localStorage };
    buttonNamed(m.form_view_submit())!.click();
    await settle();
    expect(state.submitted.map((b) => b.answers)).toEqual([{ q1: 'Envoye' }]);
    expect({ ...localStorage }).toEqual(before);
    // Answered now: the page says so, it does not draw the answer back.
    expect(byTestId('form-already-answered')).not.toBeNull();
  });
});
