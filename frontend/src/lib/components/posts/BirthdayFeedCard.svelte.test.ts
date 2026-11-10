// @vitest-environment happy-dom
/**
 * THE BIRTHDAY FEED CARD (docs/wiki/birthdays.md): quiet, shown only once the server has answered
 * that the account has no birthday and has not dismissed the help; the cross and "Ajouter" both
 * record the help in the account's server-side set, so it never returns.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));

const helps = vi.hoisted(() => ({ state: { ready: true } as { ready: boolean } }));
vi.mock('$lib/guidance/seenHelps.svelte', async () => {
  const { SvelteSet } = await import('svelte/reactivity');
  const seen = new SvelteSet<string>();
  return {
    seenHelps: {
      get ready() {
        return helps.state.ready;
      },
      has: (id: string) => seen.has(id),
      markSeen: (id: string) => void seen.add(id),
    },
    __seen: seen,
  };
});

import BirthdayFeedCard from './BirthdayFeedCard.svelte';
import { ownBirthday } from '$lib/birthdays/birthdaysToday.svelte';
import { m } from '$lib/paraglide/messages';
import * as seenModule from '$lib/guidance/seenHelps.svelte';

const seen = (seenModule as unknown as { __seen: SvelteSet<string> }).__seen;
let component: ReturnType<typeof mount> | null = null;

async function render() {
  component = mount(BirthdayFeedCard, { target: document.body });
  await tick();
  flushSync();
}
const card = () => document.querySelector('[data-testid="birthday-feed-card"]');

beforeEach(() => {
  nav.goto.mockClear();
  seen.clear();
  helps.state.ready = true;
  ownBirthday.set('me', false);
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the birthday feed card', () => {
  it('shows a quiet line for an account with no birthday', async () => {
    await render();
    expect(card()?.textContent).toContain(m.birthday_card_title());
  });

  it('shows nothing while the server has not answered either fact, or when a date exists', async () => {
    helps.state.ready = false;
    await render();
    expect(card()).toBeNull();
    unmount(component!);
    helps.state.ready = true;
    ownBirthday.set('me', true);
    component = mount(BirthdayFeedCard, { target: document.body });
    await tick();
    expect(card()).toBeNull();
  });

  it('is gone for good once dismissed, and records the help', async () => {
    await render();
    (document.querySelector(`[aria-label="${m.common_close_label()}"]`) as HTMLElement).click();
    await tick();
    flushSync();
    expect(seen.has('prompt-birthday')).toBe(true);
    expect(card()).toBeNull();
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('"Ajouter" records the help and opens the birthday settings', async () => {
    await render();
    const add = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.birthday_card_action()
    ) as HTMLElement;
    add.click();
    await tick();
    expect(seen.has('prompt-birthday')).toBe(true);
    expect(nav.goto).toHaveBeenCalledWith(expect.stringContaining('birthday'));
  });
});
