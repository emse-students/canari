import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  listMutedAssociations: vi.fn(),
  unmuteAssociationPush: vi.fn(),
}));
vi.mock('$lib/associations/api', () => api);

import SettingsMutedAssociations from './SettingsMutedAssociations.svelte';
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
  component = mount(SettingsMutedAssociations, { target: document.body });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  api.unmuteAssociationPush.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('SettingsMutedAssociations', () => {
  it('says so when nothing is muted', async () => {
    api.listMutedAssociations.mockResolvedValue([]);
    await render();
    expect(document.body.textContent).toContain(m.settings_notif_muted_empty());
    expect(document.querySelectorAll('li')).toHaveLength(0);
  });

  it('lists the muted associations and unmutes one, leaving the others', async () => {
    api.listMutedAssociations.mockResolvedValue([
      { id: 'a1', name: 'BDE', slug: 'bde', logoUrl: null },
      { id: 'a2', name: 'BDS', slug: 'bds', logoUrl: null },
    ]);
    await render();
    expect(document.querySelectorAll('li')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('[data-association="a1"] button')!.click();
    await settle();

    expect(api.unmuteAssociationPush).toHaveBeenCalledWith('a1');
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(document.querySelector('[data-association="a2"]')).not.toBeNull();
  });

  it('keeps the row and shows the error when the unmute is refused', async () => {
    api.listMutedAssociations.mockResolvedValue([
      { id: 'a1', name: 'BDE', slug: 'bde', logoUrl: null },
    ]);
    api.unmuteAssociationPush.mockRejectedValue(new Error('boom'));
    await render();
    document.querySelector<HTMLButtonElement>('[data-association="a1"] button')!.click();
    await settle();
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(document.body.textContent).toContain(m.settings_notifications_save_error());
  });
});
