// @vitest-environment happy-dom
/**
 * THE SETTINGS ROW BEHIND THE ALUMNI LINK CARD (docs/wiki/profiles-and-access.md, D44): the card's
 * cross is permanent, so the row stays under the SAME rule (`alumniLinkReminderDue`) and ignores the
 * dismissal; it opens the same MiConnect sources page and leaves once the link exists.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
const ext = vi.hoisted(() => ({ open: vi.fn((_url: string) => Promise.resolve()) }));
vi.mock('$lib/utils/openExternal', () => ({ openExternal: ext.open }));
vi.mock('$lib/stores/auth', () => ({ authentikUrl: () => 'https://id.example.test' }));
const prof = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'me',
  fetchMyProfile: () => Promise.resolve(prof.value),
}));
// The feed card's dismissal: this row must never read it.
const seen = vi.hoisted(() => ({ has: vi.fn((_id: string) => true) }));
vi.mock('$lib/guidance/seenHelps.svelte', () => ({
  seenHelps: { ready: true, has: seen.has, markSeen: () => {} },
}));

import SettingsAlumniLinkRow from './SettingsAlumniLinkRow.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;
const DUE = { alumniLinked: false, cursus: [{ formation: 'ICM', promo: 2000 }] };

async function render() {
  component = mount(SettingsAlumniLinkRow, { target: document.body });
  await tick();
  await tick();
}
const row = () => document.querySelector('[data-testid="settings-alumni-link-row"]');

beforeEach(() => {
  ext.open.mockClear();
  seen.has.mockClear();
  prof.value = DUE;
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('the settings Alumni link row', () => {
  it('shows under the reminder rule even when the card was dismissed', async () => {
    await render();
    expect(row()?.textContent).toContain(m.settings_alumni_link_heading());
    expect(seen.has).not.toHaveBeenCalled();
  });

  it.each([
    ['the link exists', { ...DUE, alumniLinked: true }],
    ['the link is unknown', { ...DUE, alumniLinked: null }],
    ['there is no cursus', { alumniLinked: false, cursus: [] }],
    ['it is not due yet', { alumniLinked: false, cursus: [{ formation: 'ICM', promo: 2999 }] }],
  ])('shows nothing when %s', async (_name, profile) => {
    prof.value = profile;
    await render();
    expect(row()).toBeNull();
  });

  it('opens MiConnect sources settings', async () => {
    await render();
    (row()!.querySelector('button') as HTMLElement).click();
    await tick();
    expect(ext.open).toHaveBeenCalledWith(expect.stringContaining('page-sources'));
  });
});
