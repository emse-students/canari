// @vitest-environment happy-dom
/**
 * THE ALUMNI LINK CARD (docs/wiki/profiles-and-access.md, D44): the birthday card's pattern. Shown
 * only once the help set is known, the help is not seen and `alumniLinkReminderDue` says so; the cross
 * records the help for good, the link action opens MiConnect and records nothing.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import type { SvelteSet } from 'svelte/reactivity';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
const ext = vi.hoisted(() => ({ open: vi.fn((_url: string) => Promise.resolve()) }));
vi.mock('$lib/utils/openExternal', () => ({ openExternal: ext.open }));
vi.mock('$lib/stores/auth', () => ({ authentikUrl: () => 'https://id.example.test' }));
const prof = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'me',
  fetchMyProfile: () => Promise.resolve(prof.value),
}));
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

import AlumniLinkCard from './AlumniLinkCard.svelte';
import { m } from '$lib/paraglide/messages';
import * as seenModule from '$lib/guidance/seenHelps.svelte';

const seen = (seenModule as unknown as { __seen: SvelteSet<string> }).__seen;
let component: ReturnType<typeof mount> | null = null;

/** A cursus whose reminder started long ago, so the date is never what is under test. */
const DUE = { alumniLinked: false, cursus: [{ formation: 'ICM', promo: 2000 }] };

async function render() {
  component = mount(AlumniLinkCard, { target: document.body });
  await tick();
  await tick();
  flushSync();
}
const card = () => document.querySelector('[data-testid="alumni-link-card"]');

beforeEach(() => {
  ext.open.mockClear();
  seen.clear();
  helps.state.ready = true;
  prof.value = DUE;
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the Alumni link card', () => {
  it('shows the quiet line for an account whose link is due and missing', async () => {
    await render();
    expect(card()?.textContent).toContain(m.alumni_link_card_text());
  });

  it.each([
    ['the link exists', { ...DUE, alumniLinked: true }],
    ['the link is unknown', { ...DUE, alumniLinked: null }],
    ['there is no cursus', { alumniLinked: false, cursus: [] }],
    ['it is not due yet', { alumniLinked: false, cursus: [{ formation: 'ICM', promo: 2999 }] }],
  ])('shows nothing when %s', async (_name, profile) => {
    prof.value = profile;
    await render();
    expect(card()).toBeNull();
  });

  it('shows nothing before the help set is known, or once dismissed', async () => {
    helps.state.ready = false;
    await render();
    expect(card()).toBeNull();
    unmount(component!);
    helps.state.ready = true;
    seen.add('prompt-alumni-link');
    component = mount(AlumniLinkCard, { target: document.body });
    await tick();
    await tick();
    expect(card()).toBeNull();
  });

  it('the cross records the help for good and opens nothing', async () => {
    await render();
    (document.querySelector(`[aria-label="${m.common_close_label()}"]`) as HTMLElement).click();
    await tick();
    flushSync();
    expect(seen.has('prompt-alumni-link')).toBe(true);
    expect(card()).toBeNull();
    expect(ext.open).not.toHaveBeenCalled();
  });

  it('the link action opens MiConnect sources settings and records nothing', async () => {
    await render();
    const link = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.alumni_link_card_action()
    ) as HTMLElement;
    link.click();
    await tick();
    expect(ext.open).toHaveBeenCalledWith(expect.stringContaining('page-sources'));
    expect(seen.has('prompt-alumni-link')).toBe(false);
  });
});
