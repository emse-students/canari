// @vitest-environment happy-dom
/**
 * THE PAYMENT RETURN ANNOUNCES ITS ANSWER ITSELF (iPhone 12, v1.2.9-alpha.4: SvelteKit's route
 * announcer, which reads the title once at the navigation, still said "Verification du paiement..."
 * over "Paiement introuvable"). The answer block is a polite status region present from the first
 * frame, so what replaces the verifying line is announced; the router is never asked to re-read.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { pageTitle } from '$lib/seo/pageTitle.svelte';

const answer = vi.hoisted(() => ({
  confirm: vi.fn(),
  replaceState: vi.fn(),
  url: { current: new URL('https://canari.test/forms/success?submission_id=s1') },
}));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return answer.url.current;
    },
    state: {},
  },
}));
vi.mock('$app/navigation', () => ({ replaceState: answer.replaceState }));
vi.mock('$lib/forms/api', async (orig) => ({
  ...(await orig<typeof import('$lib/forms/api')>()),
  confirmSubmissionPayment: answer.confirm,
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  answer.replaceState.mockReset();
  answer.url.current = new URL('https://canari.test/forms/success?submission_id=s1');
  vi.restoreAllMocks();
});

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  flushSync();
  return {
    region: () => document.querySelector<HTMLElement>('[data-payment-answer]')!,
    settle: async () => {
      for (let i = 0; i < 5; i++) await tick();
      flushSync();
    },
  };
}

describe('the payment return announces its own answer', () => {
  it('the verifying line and the answer that replaces it live in ONE status region', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    answer.confirm.mockRejectedValue(new Error('not found'));
    const { region, settle } = await render();
    const before = region();
    expect(before.getAttribute('role')).toBe('status');
    expect(before.textContent).toContain(m.form_success_verifying());
    await settle();
    expect(region()).toBe(before);
    expect(before.textContent).toContain(m.form_success_not_found_heading());
    expect(before.textContent).not.toContain(m.form_success_verifying());
  });

  it('reads the heading and its sentence only - the way back is outside the region', async () => {
    answer.confirm.mockResolvedValue({ formId: 'f1', paymentStatus: 'paid' });
    const { region, settle } = await render();
    await settle();
    const link = [...document.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === m.form_success_back_to_form()
    );
    expect(link, 'the way back is drawn').toBeTruthy();
    expect(region().contains(link!)).toBe(false);
    expect(region().querySelector('a')).toBeNull();
    expect(region().textContent).toContain(m.form_success_confirmed_heading());
    expect(region().textContent).toContain(m.form_success_confirmed_desc());
  });

  it('never rewrites the history entry to make the router re-read the title', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    answer.confirm.mockRejectedValue(new Error('not found'));
    const { settle } = await render();
    await settle();
    expect(answer.replaceState).not.toHaveBeenCalled();
  });

  it('a return with no submission starts on its answer - its first title is already right', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer.url.current = new URL('https://canari.test/forms/success');
    const { region } = await render();
    expect(pageTitle.current).toBe(m.form_success_not_found_heading());
    expect(region().textContent).not.toContain(m.form_success_verifying());
  });
});
