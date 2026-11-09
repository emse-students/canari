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
