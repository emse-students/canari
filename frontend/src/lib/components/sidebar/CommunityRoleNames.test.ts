// @vitest-environment happy-dom
/**
 * THE ROLE-NAME EDITOR: one field per role, the default name as its placeholder, a blank field
 * saving as a RESET, and a refusal named from its code - never from prose.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CommunityRoleNames from './CommunityRoleNames.svelte';
import { m } from '$lib/paraglide/messages';
import { ChannelApiError } from '$lib/services/ChannelService';

const roles = [
  { id: 'r-member', name: 'Membre', priority: 10, label: null },
  { id: 'r-admin', name: 'Administrateur', priority: 100, label: 'Presidence' },
  { id: 'r-mod', name: 'Moderateur', priority: 50, label: null },
];

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(onSave = vi.fn().mockResolvedValue(undefined)) {
  const instance = mount(CommunityRoleNames, { target: document.body, props: { roles, onSave } });
  mounted.push(() => unmount(instance));
  flushSync();
  return onSave;
}

const rows = () => [...document.querySelectorAll('[data-testid="role-name-row"]')];
const input = (row: Element) => row.querySelector('input') as HTMLInputElement;
const buttons = (row: Element) => [...row.querySelectorAll('button')] as HTMLButtonElement[];
const type = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

describe('CommunityRoleNames', () => {
  it('draws one field per role, admin first, the default name as placeholder, 40 characters at most', () => {
    render();
    expect(rows().map((r) => input(r).placeholder)).toEqual([
      m.chat_role_admin(),
      m.chat_role_moderator(),
      m.chat_role_member(),
    ]);
    expect(input(rows()[0]).value).toBe('Presidence');
    expect(input(rows()[1]).value).toBe('');
    expect(input(rows()[0]).maxLength).toBe(40);
  });

  it('saves the typed name of that role, trimmed, only once it differs', async () => {
    const onSave = render();
    const mod = rows()[1];
    expect(buttons(mod)[0].disabled).toBe(true);
    type(input(mod), '  Bureau ');
    expect(buttons(mod)[0].disabled).toBe(false);
    buttons(mod)[0].click();
    await settle();
    expect(onSave).toHaveBeenCalledWith('r-mod', 'Bureau');
  });

  it('saves a cleared field as a reset, and offers a reset only where a name is set', async () => {
    const onSave = render();
    expect(buttons(rows()[1])).toHaveLength(1);
    const admin = rows()[0];
    expect(buttons(admin)).toHaveLength(2);
    type(input(admin), '   ');
    buttons(admin)[0].click();
    await settle();
    expect(onSave).toHaveBeenLastCalledWith('r-admin', null);
    buttons(admin)[1].click();
    await settle();
    expect(onSave).toHaveBeenLastCalledWith('r-admin', null);
  });

  it('names a refusal from its code', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(new ChannelApiError(400, 'ROLE_LABEL_INVALID', 'invalid'));
    render(onSave);
    const mod = rows()[1];
    type(input(mod), 'Bureau');
    buttons(mod)[0].click();
    await settle();
    expect(mod.textContent).toContain(m.chat_role_name_invalid_error());
  });
});
