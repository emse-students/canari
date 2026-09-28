/**
 * THE PERMISSION GRID SHOWS EVERY ROLE WITHOUT A SIDEWAYS SCROLL, AT ANY WIDTH.
 *
 * It was a matrix - one column per role - and the gate that guarded it summed its `min-width`
 * floors against the side panel: 336px against 384px, green. On screen the role pills set the width
 * ("@ADMINISTRATEUR" alone is ~150px), so at 390 only the admin column was visible and the other
 * roles sat behind a horizontal scroll nothing announced. The user's report of 2026-09-27: "plein
 * d'elements sont invisibles". A sum of floors could not see it, because a floor never limits a
 * width; so this suite asserts the SHAPE that makes the width independent of the role count - one
 * section per role, nothing that scrolls sideways - and what each section shows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PermissionGrid from './PermissionGrid.svelte';
import { m } from '$lib/paraglide/messages';

const roles = [
  { id: 'member', name: 'Membre', priority: 10 },
  { id: 'admin', name: 'Administrateur', priority: 100 },
  { id: 'mod', name: 'Moderateur', priority: 50 },
];
const permissions = [
  { key: 'INVITE', label: 'Inviter des membres', tooltip: 'Peut envoyer des invitations' },
  { key: 'KICK', label: 'Expulser des membres', tooltip: 'Peut retirer un membre' },
];

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(onToggle = vi.fn()) {
  const instance = mount(PermissionGrid, {
    target: document.body,
    props: {
      roles,
      permissions,
      overrides: [{ roleId: 'mod', permission: 'INVITE', value: 'allow' as const }],
      onToggle,
      disableDeny: true,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return onToggle;
}

const sections = () => [...document.querySelectorAll('section')];

describe('PermissionGrid', () => {
  it('draws one section per role, admin first, and nothing that scrolls sideways', () => {
    render();
    expect(sections().map((s) => s.querySelector('header')?.textContent?.trim())).toEqual([
      '@Administrateur',
      '@Moderateur',
      '@Membre',
    ]);
    expect(document.querySelector('table')).toBeNull();
    expect(document.querySelector('.overflow-x-auto')).toBeNull();
  });

  it('states the locked admin role in one line instead of disabled toggles', () => {
    render();
    const admin = sections()[0];
    expect(admin.querySelectorAll('button')).toHaveLength(0);
    expect(admin.textContent).toContain(m.chat_permission_grid_admin_locked());
  });

  it('prints each permission description, which no touch screen can show as a tooltip', () => {
    render();
    const member = sections()[2];
    expect(member.textContent).toContain('Peut envoyer des invitations');
    expect(member.textContent).toContain('Peut retirer un membre');
  });

  it('toggles the role and permission of the row that was clicked', () => {
    const onToggle = render();
    const [, mod, member] = sections();
    const toggles = (s: Element) => [...s.querySelectorAll('button')];
    expect(toggles(mod)).toHaveLength(2);

    toggles(mod)[0].click();
    expect(onToggle).toHaveBeenLastCalledWith('mod', 'INVITE', 'neutral');
    toggles(member)[1].click();
    expect(onToggle).toHaveBeenLastCalledWith('member', 'KICK', 'allow');
    expect(toggles(member)[1].getAttribute('aria-label')).toBe(
      m.chat_permission_grid_cell_hint({
        label: 'Expulser des membres',
        state: m.chat_permission_state_no(),
      })
    );
  });
});
