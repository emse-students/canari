// @vitest-environment happy-dom
/**
 * THE PREVIEW TEST SEND REFUSES AN UPLOAD STILL RUNNING, exactly as the real send does
 * (coordinator review of PR 4165): the wait is said and no success is reported.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';

const route = vi.hoisted(() => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'u1',
  getSavedDisplayName: () => 'Ada',
}));
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
const api = vi.hoisted(() => ({
  status: 'draft' as 'draft' | 'published',
  required: false,
  checkSubmission: vi.fn(() =>
    Promise.resolve({
      hasSubmitted: false,
      formFull: false,
      pricing: null,
      cursusSlices: [{ pricing: null, productGridPrices: {} }],
      hiddenItemIds: [],
      maySubmit: true,
    })
  ),
  submitForm: vi.fn(),
  revision: { revision: 0, document: null as Record<string, unknown> | null, savedAt: null },
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Soiree',
      description: '',
      status: api.status,
      items: [{ id: 'q1', label: 'Nom', required: api.required, type: 'short_text' }],
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
    }),
  checkSubmission: api.checkSubmission,
  submitForm: api.submitForm,
  getFormDraft: () => Promise.resolve(api.revision),
}));

vi.mock(
  '$lib/components/forms/FormQuestion.svelte',
  () => import('./uploadingQuestionStub.svelte')
);

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  api.revision = { revision: 0, document: null, savedAt: null };
  api.required = false;
});

async function open(url: string) {
  route.page.url = new URL(url);
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

describe('"Tester l\'envoi" while a file is still uploading', () => {
  it('is refused as the send refuses it: the wait is said and no success is reported', async () => {
    api.status = 'draft';
    await open('https://canari.test/forms/f1?preview=1');
    document.querySelector<HTMLButtonElement>('[data-testid="form-test-send"]')!.click();
    for (let i = 0; i < 4; i++) {
      await tick();
      flushSync();
    }
    expect(document.querySelector('[data-testid="form-test-send-report"]')).toBeNull();
    expect(document.body.textContent).toContain(m.form_file_wait_upload());
    expect(api.submitForm).not.toHaveBeenCalled();
  });
});
