// @vitest-environment happy-dom
/**
 * A HIDDEN COLUMN'S NAME NEVER GOES BACK TO A FORMER ONE (review of #2590, the blocker). The server
 * renames a space's hidden column with the space (WP-R1). The editor's copy of the column used to
 * stay on the former name, so: create "Old", rename the space "New", add a column, then save the
 * first column's fields - and the save wrote "Old" back. The editor now re-seeds its copy from the
 * resource and sends a name only when the organiser typed one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const updateSpace = vi.hoisted(() => vi.fn());
const addResource = vi.hoisted(() => vi.fn());
const updateResource = vi.hoisted(() => vi.fn());

vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  updateSpace: (...a: unknown[]) => updateSpace(...a),
  addResource: (...a: unknown[]) => addResource(...a),
  updateResource: (...a: unknown[]) => updateResource(...a),
}));
vi.mock('$lib/navigation/unsavedChanges', () => ({
  guardUnsavedChanges: () => ({ release: () => {} }),
}));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { ManagedSpace } from '$lib/bookings/api';
import SpaceEditor from './SpaceEditor.svelte';

const SPACE: ManagedSpace = {
  id: 's1',
  ownerId: 'o',
  associationId: null,
  resources: [
    {
      id: 'r1',
      name: 'Old',
      description: null,
      privateInfo: null,
      linkedUserId: null,
      position: 0,
      lines: [],
      exceptions: [],
    },
  ],
  poster: null,
  name: 'Old',
  description: null,
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 30,
  maxSteps: 4,
  slotMinutes: null,
  nameVisibility: 'occupied',
  discoverability: 'listed',
  audience: null,
  items: [],
  privateInfo: null,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
  maxActiveBookings: null,
  maxMinutesPerPeriod: null,
  quotaPeriod: null,
  participantWithdrawMinMinutes: 0,
  maxPeople: null,
  retentionDays: 7,
};

const mounted: ReturnType<typeof mount>[] = [];

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

beforeEach(() => {
  setLocale('en', { reload: false });
  updateSpace.mockReset().mockResolvedValue({ ok: true });
  addResource.mockReset().mockResolvedValue({ id: 'r2' });
  updateResource.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('SpaceEditor, the hidden column (WP-R1)', () => {
  it('rename the space, reveal the columns, save the first column: the former name is never sent', async () => {
    mounted.push(
      mount(SpaceEditor, {
        target: document.body,
        props: {
          initial: structuredClone(SPACE),
          tiers: [],
          formations: [],
          onSaved: () => {},
          onDeleted: () => {},
        },
      })
    );
    flushSync();
    // Hidden: no column name field, the "one column" card instead.
    expect(document.getElementById('resource-r1-name')).toBeNull();
    expect(document.body.textContent).toContain(m.bookings_columns_hidden_title());

    // 1. Rename the space.
    type(document.getElementById('space-name') as HTMLInputElement, 'New');
    button(m.bookings_save_settings()).click();
    await settle();
    expect(updateSpace).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'New' }));

    // 2. Reveal the columns by adding one.
    button(m.bookings_resource_add_button()).click();
    flushSync();
    type(document.getElementById('space-new-column') as HTMLInputElement, 'Camille');
    button(m.bookings_columns_add_confirm()).click();
    await settle();
    expect(addResource).toHaveBeenCalledWith('s1', { name: 'Camille', position: 1 });

    // The first column is visible now, and reads the name the server gave it.
    const firstName = document.getElementById('resource-r1-name') as HTMLInputElement;
    expect(firstName.value).toBe('New');

    // 3. Edit the first column's description and save it.
    type(document.getElementById('resource-r1-description') as HTMLTextAreaElement, 'Sous-sol');
    const saves = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === m.bookings_resource_save()
    );
    saves[0].click();
    await settle();
    expect(updateResource).toHaveBeenCalledTimes(1);
    const [id, fields] = updateResource.mock.calls[0];
    expect(id).toBe('r1');
    expect(fields).not.toHaveProperty('name');
    expect(fields).toMatchObject({ description: 'Sous-sol' });
  });

  it('the mode switch stores a slot length, and a switch back to step clears it (migration 116)', async () => {
    mounted.push(
      mount(SpaceEditor, {
        target: document.body,
        props: {
          initial: structuredClone(SPACE),
          tiers: [],
          formations: [],
          onSaved: () => {},
          onDeleted: () => {},
        },
      })
    );
    flushSync();
    const tab = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (t) => t.textContent?.trim() === label
      )!;
    tab(m.bookings_mode_slots()).click();
    flushSync();
    expect(document.getElementById('space-slot-length')).not.toBeNull();
    button(m.bookings_save_settings()).click();
    await settle();
    expect(updateSpace).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ slotMode: 'slots', slotMinutes: 30, stepMinutes: null })
    );
    tab(m.bookings_mode_step()).click();
    flushSync();
    button(m.bookings_save_settings()).click();
    await settle();
    expect(updateSpace).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ slotMode: 'step', slotMinutes: null })
    );
  });

  it('a single column named otherwise is a visible column, renamable', () => {
    const legacy = structuredClone(SPACE);
    legacy.name = 'Foyer';
    legacy.resources[0].name = 'Piano';
    mounted.push(
      mount(SpaceEditor, {
        target: document.body,
        props: {
          initial: legacy,
          tiers: [],
          formations: [],
          onSaved: () => {},
          onDeleted: () => {},
        },
      })
    );
    flushSync();
    expect((document.getElementById('resource-r1-name') as HTMLInputElement).value).toBe('Piano');
    expect(document.body.textContent).not.toContain(m.bookings_columns_hidden_title());
  });
});
