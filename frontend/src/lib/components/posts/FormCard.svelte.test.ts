// @vitest-environment happy-dom
/**
 * THE BELL BELONGS TO THE CARD, WHENEVER THE FORM IS NOT OPEN YET AND NOT ANSWERED.
 *
 * Production, 2026-11-14: a post's attached form that opened later drew no "Notify me" bell. The
 * card used to look at its forms ONCE, on mount, and the form (with its `opensAt`) is read after the
 * post is drawn - so the bell was decided on an empty list and never reconsidered. Here the props
 * change after mount, which is exactly that order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const checkFormReminder = vi.fn(async (_id: string) => ({ subscribed: false }));
const subscribeFormReminder = vi.fn(async (_id: string) => undefined);
const unsubscribeFormReminder = vi.fn(async (_id: string) => undefined);

vi.mock('$lib/posts/api', () => ({
  checkFormReminder: (id: string) => checkFormReminder(id),
  subscribeFormReminder: (id: string) => subscribeFormReminder(id),
  unsubscribeFormReminder: (id: string) => unsubscribeFormReminder(id),
}));

import FormCard from './FormCard.svelte';
import { attachedFormsLoader, type AttachedFormInfo } from '$lib/posts/attachedForms.svelte';
import { createFormSummaryBatcher } from '$lib/forms/formSummaries';
import { m } from '$lib/paraglide/messages';

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const u of mounted.splice(0)) u();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function render(Component: unknown, props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const p = $state(props);
  const c = mount(Component as never, { target, props: p });
  mounted.push(() => void unmount(c));
  flushSync();
  return { target, p };
}

const bell = (t: HTMLElement) => t.querySelector('[data-testid="form-card-bell"]');

describe('FormCard bell', () => {
  it('is drawn on a form that is not open yet, and the reminder state is asked once', async () => {
    const { target } = render(FormCard, {
      formId: 'f1',
      href: '/forms/f1',
      title: 'T',
      submitted: false,
      opensAt: future(),
    });
    expect(bell(target)).not.toBeNull();
    expect(checkFormReminder).toHaveBeenCalledTimes(1);
  });

  it('appears when opensAt arrives AFTER the card mounted (fails with a mount-time read)', () => {
    const { target, p } = render(FormCard, {
      formId: 'f1',
      href: '/forms/f1',
      title: 'T',
      submitted: false,
      opensAt: undefined as string | undefined,
    });
    expect(bell(target)).toBeNull();
    p.opensAt = future();
    flushSync();
    expect(bell(target)).not.toBeNull();
    expect(checkFormReminder).toHaveBeenCalledWith('f1');
  });

  it('is absent on an open form and on an answered one', () => {
    const open = render(FormCard, {
      formId: 'a',
      href: '/x',
      title: 'T',
      submitted: false,
      opensAt: past(),
    });
    expect(bell(open.target)).toBeNull();
    const done = render(FormCard, {
      formId: 'b',
      href: '/x',
      title: 'T',
      submitted: true,
      opensAt: future(),
    });
    expect(bell(done.target)).toBeNull();
  });

  it('still draws the bell when the reminder state cannot be read', async () => {
    checkFormReminder.mockRejectedValueOnce(new Error('offline'));
    const { target } = render(FormCard, {
      formId: 'f9',
      href: '/x',
      title: 'T',
      submitted: false,
      opensAt: future(),
    });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(bell(target)).not.toBeNull();
  });

  it('is a card of the one family: the form chip, the open state, no bell', () => {
    const { target } = render(FormCard, {
      formId: 'o',
      href: '/forms/o',
      title: 'Inscriptions',
      submitted: false,
      opensAt: null,
    });
    const card = target.querySelector('[data-attachment-card="form"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-attachment-chip]')?.textContent?.trim()).toBe('Formulaire');
    expect(card?.textContent).toContain('Inscriptions');
  });

  it('subscribes on a tap', async () => {
    const { target } = render(FormCard, {
      formId: 'f2',
      href: '/x',
      title: 'T',
      submitted: false,
      opensAt: future(),
    });
    (bell(target) as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(subscribeFormReminder).toHaveBeenCalledWith('f2');
    expect(bell(target)?.getAttribute('aria-pressed')).toBe('true');
  });
});

/**
 * A STALLED OR EMPTY SUMMARY READ NEVER MAKES THE CARD CLAIM AN ANSWER (reading `1.7.3-alpha.6`,
 * #3958 row 2, second half - a stall cannot be produced on a bench without touching the network).
 *
 * The real chain: the summary batcher feeds the attached-forms loader, which feeds the card its
 * `submitted`. A fetcher that rejects (no answer) leaves the title the post carries and a `null`
 * state: the card is drawn NEUTRAL - neither "Response sent" nor an error. A fetcher that resolves
 * `[]` is an ANSWER (the form is not readable by this reader): the loader draws no card at all, so
 * "Response sent" cannot appear either.
 */
describe('FormCard over the summary batcher', () => {
  async function infosFor(fetcher: () => Promise<never[]>): Promise<AttachedFormInfo[]> {
    const batcher = createFormSummaryBatcher(fetcher);
    let loader!: ReturnType<typeof attachedFormsLoader>;
    const cleanup = $effect.root(() => {
      loader = attachedFormsLoader(() => [{ id: 'f1', title: 'Inscriptions' }], {
        readSummary: batcher,
      });
    });
    mounted.push(cleanup);
    flushSync();
    await new Promise<void>((r) => setTimeout(r, 0));
    flushSync();
    return [...loader.infos];
  }

  it('a fetcher that rejects draws the card neutral: no answered label, no error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infos = await infosFor(() => Promise.reject(new Error('stalled')));
    warn.mockRestore();
    expect(infos).toHaveLength(1);
    expect(infos[0].submitted).toBeNull();
    const { target } = render(FormCard, {
      formId: 'f1',
      href: '/forms/f1',
      title: infos[0].title,
      submitted: infos[0].submitted,
    });
    expect(target.querySelector('[data-attachment-card="form"]')).not.toBeNull();
    expect(target.textContent).not.toContain(m.post_form_response_sent());
    expect(target.textContent).not.toContain(m.link_preview_form_open());
    expect(target.querySelector('[role="alert"]')).toBeNull();
  });

  it('a fetcher resolving [] draws no card, so nothing claims an answer either', async () => {
    const infos = await infosFor(() => Promise.resolve([]));
    expect(infos).toHaveLength(0);
  });
});
