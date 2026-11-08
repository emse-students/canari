// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  listReducedBells: vi.fn(),
  setBellLevel: vi.fn(),
}));
vi.mock('$lib/follows/bell', () => api);
vi.mock('$lib/utils/users/displayNames.svelte', () => ({
  userDisplayNames: () => new Map([['u-bob', 'Bob Martin']]),
}));

import SettingsAccountBells from './SettingsAccountBells.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render() {
  component = mount(SettingsAccountBells, { target: document.body });
  await settle();
}

const A1 = '7a1c2d9e-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  api.setBellLevel.mockResolvedValue('all');
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('SettingsAccountBells', () => {
  it('says so when nothing is reduced', async () => {
    api.listReducedBells.mockResolvedValue([]);
    await render();
    expect(document.body.textContent).toContain(m.settings_bells_empty());
    expect(document.querySelectorAll('li')).toHaveLength(0);
  });

  it('lists an association by its name and a person by theirs, with each level', async () => {
    api.listReducedBells.mockResolvedValue([
      { kind: 'association', targetId: A1, level: 'none', name: 'BDE' },
      { kind: 'user', targetId: 'u-bob', level: 'lives', name: null },
    ]);
    await render();
    const asso = document.querySelector(`[data-bell="association:${A1}"]`)!;
    const person = document.querySelector('[data-bell="user:u-bob"]')!;
    expect(asso.textContent).toContain('BDE');
    expect(asso.textContent).toContain(m.bell_level_none());
    expect(person.textContent).toContain('Bob Martin');
    expect(person.textContent).toContain(m.bell_level_lives());
  });

  it('restores one to posts and lives, leaving the others', async () => {
    api.listReducedBells.mockResolvedValue([
      { kind: 'association', targetId: A1, level: 'none', name: 'BDE' },
      { kind: 'user', targetId: 'u-bob', level: 'lives', name: null },
    ]);
    await render();
    document.querySelector<HTMLButtonElement>(`[data-bell="association:${A1}"] button`)!.click();
    await settle();
    expect(api.setBellLevel).toHaveBeenCalledWith('association', A1, 'all');
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(document.querySelector('[data-bell="user:u-bob"]')).not.toBeNull();
  });

  it('keeps the row and shows the error when the restore is refused', async () => {
    api.listReducedBells.mockResolvedValue([
      { kind: 'association', targetId: A1, level: 'none', name: 'BDE' },
    ]);
    api.setBellLevel.mockRejectedValue(new Error('boom'));
    await render();
    document.querySelector<HTMLButtonElement>(`[data-bell="association:${A1}"] button`)!.click();
    await settle();
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(document.body.textContent).toContain(m.settings_notifications_save_error());
  });

  it('says so when the list cannot be read', async () => {
    api.listReducedBells.mockRejectedValue(new Error('offline'));
    await render();
    expect(document.body.textContent).toContain(m.settings_bells_load_error());
  });
});
