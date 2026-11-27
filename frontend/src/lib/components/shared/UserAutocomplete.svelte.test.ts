// @vitest-environment happy-dom
/**
 * TWO PEOPLE OF THE SAME NAME ARE TOLD APART IN THE PERSON PICKERS (D56): the search rows carry
 * their earliest promo and formation, and the picker shows the one that tells a homonym pair apart -
 * in `UserAutocomplete`, in `MultiUserSelector` (which embeds it), and in the mention list. A name
 * nobody else on screen shares gets nothing beside it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

import UserAutocomplete from './UserAutocomplete.svelte';
import MultiUserSelector from './MultiUserSelector.svelte';
import MentionDropdown from './MentionDropdown.svelte';
import { m } from '$lib/paraglide/messages';

const ROWS = [
  { id: 'a', displayName: 'Camille Durand', promo: 2018, formation: 'ICM' },
  { id: 'b', displayName: 'Camille Durand', promo: 2021, formation: 'ICM' },
  { id: 'c', displayName: 'Camille Martin', promo: 2021, formation: 'ICM' },
];

const mounted: Record<string, unknown>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = '';
  apiFetch.mockReset();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

/** Types a query, lets the debounce run, and returns each option's id -> detail text. */
async function typeAndRead(query: string): Promise<Record<string, string | null>> {
  apiFetch.mockResolvedValue(new Response(JSON.stringify(ROWS), { status: 200 }));
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(300);
  await settle();
  const out: Record<string, string | null> = {};
  document.querySelectorAll<HTMLElement>('[role="option"]').forEach((li, i) => {
    out[ROWS[i].id] = li.querySelector('[data-homonym-detail]')?.textContent?.trim() ?? null;
  });
  return out;
}

const expected = {
  a: m.picker_homonym_detail({ promo: 2018 }),
  b: m.picker_homonym_detail({ promo: 2021 }),
  c: null,
};

describe('the homonym detail in the person pickers (D56)', () => {
  it('UserAutocomplete shows the promo beside each homonym, nothing beside the others', async () => {
    mounted.push(
      mount(UserAutocomplete, {
        target: document.body,
        props: { value: '', onValueChange: () => undefined },
      })
    );
    flushSync();
    expect(await typeAndRead('Camille')).toEqual(expected);
  });

  it('MultiUserSelector shows it too', async () => {
    mounted.push(
      mount(MultiUserSelector, {
        target: document.body,
        props: { users: [], onUsersChange: () => undefined },
      })
    );
    flushSync();
    expect(await typeAndRead('Camille')).toEqual(expected);
  });

  it('the mention list shows it too', () => {
    mounted.push(
      mount(MentionDropdown, {
        target: document.body,
        props: { open: true, suggestions: ROWS, selectedIdx: -1, onSelect: () => undefined },
      })
    );
    flushSync();
    const detail = (id: string) =>
      document
        .querySelector(`[data-mention-suggestion="${id}"] [data-homonym-detail]`)
        ?.textContent?.trim() ?? null;
    expect({ a: detail('a'), b: detail('b'), c: detail('c') }).toEqual(expected);
  });
});
