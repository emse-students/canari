// @vitest-environment happy-dom
/**
 * A FORM'S LINKED-EVENT BANNER IS A DECORATION, SO ITS FAILURE DRAWS NOTHING - BUT IS SAID (#2953).
 *
 * Both reads behind the banner (the event, then its association's slug) used to be caught and
 * dropped without a line. A failure now logs at warn with its status (`transport` when no server
 * answered) and the page renders no banner for a failed event read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { SocialApiError } from '$lib/associations/api';

const route = vi.hoisted(() => ({
  page: { params: { id: 'f1' }, url: new URL('https://canari.test/forms/f1'), state: {} },
}));
vi.mock('$app/state', () => route);
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/associations/activePaymentProvider.svelte', () => ({
  activePaymentProvider: { current: 'lydia' },
  loadActivePaymentProvider: () => Promise.resolve(),
}));
vi.mock('$lib/posts/useFormReminder.svelte', () => ({
  useFormReminder: () => ({ load: () => Promise.resolve(), active: false }),
}));
const assoApi = vi.hoisted(() => ({
  getCalendarEventLinkedToForm: vi.fn(),
  getAssociation: vi.fn(),
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  ...assoApi,
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  getForm: () =>
    Promise.resolve({
      id: 'f1',
      title: 'Soiree',
      description: '',
      items: [],
      currency: 'eur',
      basePrice: 0,
      allowCashPayment: false,
      isPublic: false,
    }),
  checkSubmission: () =>
    Promise.resolve({
      hasSubmitted: false,
      formFull: false,
      pricing: null,
      hiddenItemIds: [],
      maySubmit: true,
    }),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

describe("a form's linked-event banner, when its reads fail", () => {
  it('logs a refused event read with its status and draws no banner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assoApi.getCalendarEventLinkedToForm.mockRejectedValueOnce(
      new SocialApiError('Forbidden', null, 403)
    );
    await open();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('linked event read failed status=403'),
        expect.any(SocialApiError)
      )
    );
    expect(document.querySelector('[data-form-linked-event]')).toBeNull();
  });

  it('logs a transport failure as such', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assoApi.getCalendarEventLinkedToForm.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await open();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('linked event read failed status=transport'),
        expect.any(TypeError)
      )
    );
    expect(document.querySelector('[data-form-linked-event]')).toBeNull();
  });

  it("logs a failed read of the event's association and still draws the banner", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    assoApi.getCalendarEventLinkedToForm.mockResolvedValueOnce({
      linkedEvent: {
        id: 'ev1',
        associationId: 'a1',
        title: 'Soiree',
        startsAt: '2026-11-05T18:00:00.000Z',
        status: 'validated',
      },
    });
    assoApi.getAssociation.mockRejectedValueOnce(new SocialApiError('Gone', null, 404));
    await open();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('association read failed status=404'),
        expect.any(SocialApiError)
      )
    );
    expect(document.querySelector('[data-form-linked-event]')).not.toBeNull();
  });
});
