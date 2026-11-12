// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const SEVEN = Array.from({ length: 7 }, (_, i) => ({ id: `a-${i}`, name: `Association ${i}` }));

vi.mock('$lib/associations/api', async (original) => ({
  ...(await original<typeof import('$lib/associations/api')>()),
  listAssociations: vi.fn(async () => SEVEN),
  listMyAssociations: vi.fn(async () => SEVEN),
}));
vi.mock('$lib/posts/republication', () => ({
  republishCandidates: (mine: unknown[]) => mine,
  proposalCandidates: (all: unknown[]) => all,
  personalRequestCandidates: (mine: unknown[]) => mine,
  personalRequestRefusalMessage: () => '',
}));
vi.mock('$lib/posts/api', () => ({
  proposeRepublication: vi.fn(),
  republishPost: vi.fn(),
  requestPersonalRepublication: vi.fn(),
}));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => false }));

import RepublishDialog from './RepublishDialog.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) void unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the search of the republish dialog', () => {
  it('has a name of its own: a placeholder is not one', async () => {
    component = mount(RepublishDialog, {
      target: document.body,
      props: {
        mode: 'republish',
        post: { id: 'p-1' } as never,
        onClose: () => {},
        onDone: () => {},
      },
    });
    for (let i = 0; i < 5; i++) {
      await tick();
      await Promise.resolve();
      flushSync();
    }

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;

    expect(search.getAttribute('aria-label')).toBe(m.post_republish_search_placeholder());
  });
});
