// @vitest-environment happy-dom
/**
 * THE BELL ON AN ACCOUNT (engagement WP-3): it reads the reader's level, offers the three choices in
 * the app's own picker, writes a pick at once and goes back - with a toast - when the server refuses.
 */
import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const api = vi.hoisted(() => ({ getBellLevel: vi.fn(), setBellLevel: vi.fn() }));
vi.mock('$lib/follows/bell', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => toast);

import AccountBell from './AccountBell.svelte';
import { m } from '$lib/paraglide/messages';

afterAll(adoptTransitionAnimations());

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render(kind: 'user' | 'association' = 'association', targetId = 'a1') {
  component = mount(AccountBell, { target: document.body, props: { kind, targetId } });
  await settle();
}

const bell = () => document.querySelector<HTMLElement>('[data-testid="account-bell"]')!;
const trigger = () => bell().closest('button')!;
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((o) =>
    o.textContent?.includes(label)
  )!;

async function pick(label: string) {
  trigger().click();
  await settle();
  option(label).click();
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  api.getBellLevel.mockResolvedValue('all');
  api.setBellLevel.mockImplementation((_k: string, _t: string, level: string) =>
    Promise.resolve(level)
  );
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('AccountBell', () => {
  it('reads the level of THIS account and shows it', async () => {
    api.getBellLevel.mockResolvedValue('lives');
    await render('user', 'u-bob');
    expect(api.getBellLevel).toHaveBeenCalledWith('user', 'u-bob');
    expect(bell().dataset.level).toBe('lives');
    expect(bell().textContent).toContain(m.bell_level_lives());
    expect(trigger().disabled).toBe(false);
  });

  it('offers the three levels and writes the one picked', async () => {
    await render();
    trigger().click();
    await settle();
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map((o) =>
      o.textContent?.trim()
    );
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain(m.bell_level_all());
    expect(labels[1]).toContain(m.bell_level_lives());
    expect(labels[2]).toContain(m.bell_level_none());
    option(m.bell_level_none()).click();
    await settle();
    expect(api.setBellLevel).toHaveBeenCalledWith('association', 'a1', 'none');
    expect(bell().dataset.level).toBe('none');
  });

  it('goes back to the level it had, with a toast, when the write is refused', async () => {
    api.setBellLevel.mockRejectedValue(new Error('404'));
    await render();
    await pick(m.bell_level_lives());
    expect(bell().dataset.level).toBe('all');
    expect(toast.showToast).toHaveBeenCalledWith(m.bell_save_failed());
  });

  it('stays disabled when the level cannot be read, rather than showing a guess', async () => {
    api.getBellLevel.mockRejectedValue(new Error('offline'));
    await render();
    expect(trigger().disabled).toBe(true);
    expect(api.setBellLevel).not.toHaveBeenCalled();
  });
});

describe('AccountBell, icon only (a profile header)', () => {
  it('draws the glyph alone, keeps the level in its name, and opens the same three-level menu', async () => {
    component = mount(AccountBell, {
      target: document.body,
      props: { kind: 'user', targetId: 'u-bob', iconOnly: true },
    });
    await settle();
    expect(bell().textContent?.trim()).toBe('');
    expect(trigger().getAttribute('aria-label')).toContain(m.bell_label());
    expect(trigger().getAttribute('aria-label')).toContain(m.bell_level_all());
    trigger().click();
    await settle();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
    option(m.bell_level_none()).click();
    await settle();
    expect(api.setBellLevel).toHaveBeenCalledWith('user', 'u-bob', 'none');
  });
});

describe('AccountBell, a read started by the page (weak-network audit, C3)', () => {
  it('shows the level the page asked for and asks nothing itself', async () => {
    component = mount(AccountBell, {
      target: document.body,
      props: {
        kind: 'association',
        targetId: 'a1',
        takeInitial: () => Promise.resolve('none' as const),
      },
    });
    await settle();
    expect(bell().dataset.level).toBe('none');
    expect(api.getBellLevel).not.toHaveBeenCalled();
  });

  it('a refused head-start read leaves the control disabled, and asks no second time', async () => {
    const refused = Promise.reject(new Error('x'));
    refused.catch(() => {});
    component = mount(AccountBell, {
      target: document.body,
      props: { kind: 'association', targetId: 'a1', takeInitial: () => refused },
    });
    await settle();
    expect(trigger().disabled).toBe(true);
    expect(api.getBellLevel).not.toHaveBeenCalled();
  });

  it('a remount after the head start was taken asks for itself, never reading a stale promise', async () => {
    let held: Promise<'none'> | undefined = Promise.resolve('none' as const);
    const take = () => {
      const read = held;
      held = undefined;
      return read;
    };
    component = mount(AccountBell, {
      target: document.body,
      props: { kind: 'association', targetId: 'a1', takeInitial: take },
    });
    await settle();
    expect(api.getBellLevel).not.toHaveBeenCalled();
    unmount(component);
    api.getBellLevel.mockResolvedValue('lives');
    component = mount(AccountBell, {
      target: document.body,
      props: { kind: 'association', targetId: 'a1', takeInitial: take },
    });
    await settle();
    expect(api.getBellLevel).toHaveBeenCalledTimes(1);
    expect(bell().dataset.level).toBe('lives');
  });
});
