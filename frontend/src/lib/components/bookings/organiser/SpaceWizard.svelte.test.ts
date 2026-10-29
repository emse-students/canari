// @vitest-environment happy-dom
/**
 * THE CREATION WIZARD, MOUNTED (WP-R7, D52, Q-R14). Pinned: the three steps in order, a step with
 * a problem held with its sentence, ONE creation at the end carrying the steps' answers and the
 * hidden column's hours, the owner passed through, and "Je regle tout moi-meme" handing back the
 * name typed so far without creating anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const createSpace = vi.hoisted(() => vi.fn());

vi.mock('$lib/bookings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/bookings/api')>()),
  createSpace: (...a: unknown[]) => createSpace(...a),
}));
vi.mock('$lib/forms/cotisationSettings', () => ({
  cotisationOptionsFor: () => Promise.resolve({ tiers: [] }),
}));
vi.mock('$lib/pricing/criteriaOptions', () => ({
  fetchFormations: () => Promise.resolve([]),
}));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import SpaceWizard from './SpaceWizard.svelte';

const mounted: ReturnType<typeof mount>[] = [];

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function heading(): string {
  return document.querySelector('h4')?.textContent?.trim() ?? '';
}

function open(associationId: string | null, initialName = 'Salle de musique') {
  const onCreated = vi.fn();
  const onSkip = vi.fn();
  const onCancel = vi.fn();
  mounted.push(
    mount(SpaceWizard, {
      target: document.body,
      props: { associationId, initialName, onCreated, onSkip, onCancel },
    })
  );
  flushSync();
  return { onCreated, onSkip, onCancel };
}

beforeEach(() => {
  setLocale('fr', { reload: false });
  createSpace.mockReset();
  createSpace.mockResolvedValue({ id: 'space-1', resourceId: 'col-1' });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('SpaceWizard', () => {
  it('walks the three steps and creates the space in ONE call', async () => {
    const { onCreated } = open('assoc-1');
    expect(heading()).toBe(m.bookings_wizard_step_what());
    button(m.bookings_wizard_next()).click();
    flushSync();
    expect(heading()).toBe(m.bookings_section_resources());
    button(m.bookings_wizard_next()).click();
    flushSync();
    expect(heading()).toBe(m.bookings_wizard_step_who());
    button(m.bookings_wizard_names_yes()).click();
    button(m.bookings_wizard_find_link()).click();
    flushSync();
    button(m.bookings_tab_create_button()).click();
    await tick();
    await tick();
    expect(createSpace).toHaveBeenCalledTimes(1);
    const [name, owner, hours, fields] = createSpace.mock.calls[0];
    expect(name).toBe('Salle de musique');
    expect(owner).toBe('assoc-1');
    // The working week of the default template, Monday to Friday 8h-20h.
    expect(hours.lines).toHaveLength(5);
    expect(hours.exceptions).toEqual([]);
    expect(fields).toMatchObject({
      slotMode: 'step',
      stepMinutes: 30,
      maxSteps: 4,
      audience: null,
      nameVisibility: 'names',
      discoverability: 'link',
    });
    expect(onCreated).toHaveBeenCalledWith('space-1');
  });

  it('holds the first step without a name, and says why', () => {
    open(null, '');
    button(m.bookings_wizard_next()).click();
    flushSync();
    expect(heading()).toBe(m.bookings_wizard_step_what());
    expect(document.body.textContent).toContain(m.bookings_problem_required());
  });

  it('sends a template chosen on the second step', async () => {
    open(null);
    button(m.bookings_wizard_next()).click();
    flushSync();
    (document.querySelector('[data-template="always"]') as HTMLButtonElement).click();
    flushSync();
    button(m.bookings_wizard_next()).click();
    flushSync();
    button(m.bookings_tab_create_button()).click();
    await tick();
    const [, owner, hours] = createSpace.mock.calls[0];
    expect(owner).toBeNull();
    expect(hours.lines).toHaveLength(7);
  });

  it('"Je regle tout moi-meme" hands back the name and creates nothing', () => {
    const { onSkip } = open(null, '  Foyer ');
    button(m.bookings_wizard_skip()).click();
    expect(onSkip).toHaveBeenCalledWith('Foyer');
    expect(createSpace).not.toHaveBeenCalled();
  });
});
