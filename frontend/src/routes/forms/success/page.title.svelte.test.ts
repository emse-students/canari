// @vitest-environment happy-dom
/**
 * THE PAYMENT RETURN'S TITLE SAYS WHAT THE PAGE SAYS (iPhone 12, v1.2.9-alpha.3: "Paiement reussi"
 * over "Paiement introuvable" for an unknown submission).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { pageTitle } from '$lib/seo/pageTitle.svelte';

const answer = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/forms/success?submission_id=s1'), state: {} },
}));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  confirmSubmissionPayment: answer.confirm,
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  flushSync();
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
}

describe('the payment return title', () => {
  it('reads "Paiement introuvable" when the submission is unknown, never "Paiement reussi"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    answer.confirm.mockRejectedValue(new Error('not found'));
    await render();
    expect(document.body.textContent).toContain(m.form_success_not_found_heading());
    expect(pageTitle.current).toBe(m.form_success_not_found_heading());
  });

  it('follows a confirmed payment', async () => {
    answer.confirm.mockResolvedValue({ formId: 'f1', paymentStatus: 'paid' });
    await render();
    expect(pageTitle.current).toBe(m.form_success_confirmed_heading());
  });

  it('gives the path its own title back when the page goes', async () => {
    answer.confirm.mockResolvedValue({ formId: 'f1', paymentStatus: 'paid' });
    await render();
    mounted.splice(0).forEach((f) => f());
    expect(pageTitle.current).toBeNull();
  });
});
