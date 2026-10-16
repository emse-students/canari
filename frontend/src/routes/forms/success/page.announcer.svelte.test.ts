/**
 * THE ROUTE ANNOUNCER FOLLOWS THE PAYMENT RETURN'S ANSWER (iPhone 12, v1.2.9-alpha.4: the hidden
 * announcer still read "Verification du paiement..." over "Paiement introuvable"). SvelteKit's
 * announcer re-reads `document.title` on a page-store update, so the page asks for one, through a
 * shallow `replaceState` of the current url, once its answer is known.
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
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
}

describe('the payment return and the route announcer', () => {
  it('asks the announcer to read the title again once the answer is known, the title already written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    let titleWhenAsked: string | null = null;
    answer.replaceState.mockImplementation(() => (titleWhenAsked = pageTitle.current));
    answer.confirm.mockRejectedValue(new Error('not found'));
    await render();
    expect(answer.replaceState).toHaveBeenCalledTimes(1);
    expect(answer.replaceState).toHaveBeenCalledWith('', {});
    expect(titleWhenAsked).toBe(pageTitle.current);
  });

  it('never asks while the page is still verifying', async () => {
    answer.confirm.mockReturnValue(new Promise(() => {}));
    await render();
    expect(answer.replaceState).not.toHaveBeenCalled();
  });

  it('never asks when the return carries no submission - nothing was learned after the navigation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer.url.current = new URL('https://canari.test/forms/success');
    await render();
    expect(pageTitle.current).toBe(m.form_success_not_found_heading());
    expect(answer.replaceState).not.toHaveBeenCalled();
  });
});
