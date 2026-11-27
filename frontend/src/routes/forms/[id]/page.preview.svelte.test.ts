// @vitest-environment happy-dom
/**
 * "VOIR LE FORMULAIRE" ON A DRAFT OPENS A PREVIEW THAT SENDS NOTHING (owner, 2026-11-08).
 *
 * The questions are drawn, the preview is said, the send button is shut, and no reader-state call is
 * made (a draft's check answers as for an absent form). A published form opened without the flag is
 * the live page, sendable.
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
  /** When set, the form's questions instead of the single free-text one. */
  items: null as Record<string, unknown>[] | null,
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
      items: api.items ?? [{ id: 'q1', label: 'Nom', required: api.required, type: 'short_text' }],
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
    }),
  checkSubmission: api.checkSubmission,
  submitForm: api.submitForm,
  getFormDraft: () => Promise.resolve(api.revision),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  api.revision = { revision: 0, document: null, savedAt: null };
  api.required = false;
  api.items = null;
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

const sendButton = () =>
  [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.form_preview_submit_disabled())
  );

describe('the fill page as a preview', () => {
  it('a draft: the preview is said, the questions drawn, the send shut, nothing asked or sent', async () => {
    api.status = 'draft';
    await open('https://canari.test/forms/f1?preview=1');
    expect(document.querySelector('[data-testid="form-preview-banner"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Nom');
    const send = sendButton()!;
    expect(send.disabled).toBe(true);
    send.click();
    expect(api.submitForm).not.toHaveBeenCalled();
    expect(api.checkSubmission).not.toHaveBeenCalled();
  });

  it('a published form opened WITH the flag by a respondent: still the live page, sendable', async () => {
    api.status = 'published';
    await open('https://canari.test/forms/f1?preview=1');
    expect(document.querySelector('[data-testid="form-preview-banner"]')).toBeNull();
    expect(sendButton()).toBeUndefined();
    expect(api.checkSubmission).toHaveBeenCalledTimes(1);
  });

  it('a published form with unpublished edits: the preview draws the edits, and sends nothing', async () => {
    api.status = 'published';
    api.revision = {
      revision: 3,
      document: {
        title: 'Soiree (en cours)',
        items: [{ id: 'q9', label: 'Allergies', required: false, type: 'short_text' }],
      },
      savedAt: null,
    };
    await open('https://canari.test/forms/f1?preview=1');
    expect(document.querySelector('[data-testid="form-preview-banner"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Allergies');
    expect(document.body.textContent).not.toContain('Nom');
    expect(sendButton()!.disabled).toBe(true);
    expect(api.checkSubmission).not.toHaveBeenCalled();
  });

  it('a published form opened without the flag: the live page, no preview', async () => {
    api.status = 'published';
    await open('https://canari.test/forms/f1');
    expect(document.querySelector('[data-testid="form-preview-banner"]')).toBeNull();
    expect(sendButton()).toBeUndefined();
    expect(api.checkSubmission).toHaveBeenCalledTimes(1);
  });

  describe('the preview test send (owner, 2026-11-17)', () => {
    const testButton = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="form-test-send"]');
    const report = () => document.querySelector('[data-testid="form-test-send-report"]');

    it('is offered in a preview only, never on the live page', async () => {
      api.status = 'published';
      await open('https://canari.test/forms/f1');
      expect(testButton()).toBeNull();
    });

    it('a complete answer: the test passes, says nothing was saved, and sends nothing', async () => {
      api.status = 'draft';
      await open('https://canari.test/forms/f1?preview=1');
      expect(report()).toBeNull();
      testButton()!.click();
      for (let i = 0; i < 4; i++) {
        await tick();
        flushSync();
      }
      expect(report()?.textContent).toContain(m.form_test_send_ok_free());
      expect(api.submitForm).not.toHaveBeenCalled();
      expect(api.checkSubmission).not.toHaveBeenCalled();
    });

    it('a required question left empty: the test refuses it as the send does, and reports nothing', async () => {
      api.status = 'draft';
      api.required = true;
      await open('https://canari.test/forms/f1?preview=1');
      testButton()!.click();
      for (let i = 0; i < 4; i++) {
        await tick();
        flushSync();
      }
      expect(report()).toBeNull();
      expect(api.submitForm).not.toHaveBeenCalled();
    });

    describe('the answer formats, judged as the send judges them', () => {
      const number = {
        id: 'n1',
        label: 'Age',
        type: 'short_text',
        format: 'number',
        min: 1,
        max: 10,
      };
      const email = { id: 'e1', label: 'Mail', type: 'short_text', format: 'email' };

      /** Types into a question's own field, then presses the test. */
      async function typeThenTest(typed: Record<string, string>) {
        api.status = 'draft';
        api.items = [number, email];
        await open('https://canari.test/forms/f1?preview=1');
        for (const [id, text] of Object.entries(typed)) {
          const field = document.querySelector<HTMLInputElement>(`#q-${id} input`)!;
          field.value = text;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        testButton()!.click();
        for (let i = 0; i < 4; i++) {
          await tick();
          flushSync();
        }
      }
      const card = (id: string) => document.getElementById(`q-${id}`)?.textContent ?? '';

      it('a number above the maximum is refused, worded on its card', async () => {
        await typeThenTest({ n1: '99', e1: 'a@b.fr' });
        expect(report()).toBeNull();
        expect(card('n1')).toContain(m.form_view_error_format_max({ label: 'Age', max: 10 }));
      });

      it('a number below the minimum is refused, worded on its card', async () => {
        await typeThenTest({ n1: '0', e1: 'a@b.fr' });
        expect(report()).toBeNull();
        expect(card('n1')).toContain(m.form_view_error_format_min({ label: 'Age', min: 1 }));
      });

      it('an invalid e-mail is refused, worded on its card', async () => {
        await typeThenTest({ n1: '5', e1: 'pasunmail' });
        expect(report()).toBeNull();
        expect(card('e1')).toContain(m.form_view_error_format_email({ label: 'Mail' }));
      });

      it('valid answers: the test passes and nothing is sent', async () => {
        await typeThenTest({ n1: '5', e1: 'a@b.fr' });
        expect(report()?.textContent).toContain(m.form_test_send_ok_free());
        expect(api.submitForm).not.toHaveBeenCalled();
      });
    });
  });
});
