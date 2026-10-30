// @vitest-environment happy-dom
/**
 * THE CREATION WIZARD, MOUNTED (WP-R7, D52, Q-R14). Pinned: the three steps in order, a step with
 * a problem held with its sentence, ONE creation at the end carrying the steps' answers and the
 * hidden column's hours, the owner passed through; the steps held while a poster uploads, then the
 * poster carried (review of #2687); the dated line of "Evenement ponctuel"; the focus moved to each
 * step's heading; and "Je regle tout moi-meme" handing back the name without creating anything.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const createSpace = vi.hoisted(() => vi.fn());
/** The poster's upload, answered when the test chooses: the window the review named. */
const upload = vi.hoisted(() => ({ resolve: (_: unknown) => {} }));

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
vi.mock('$lib/media', () => ({
  preparePostMedia: (file: File) => Promise.resolve({ file, dims: null }),
  MediaService: class {
    encryptAndUpload() {
      return new Promise((resolve) => (upload.resolve = resolve));
    }
    downloadAndDecrypt() {
      return new Promise(() => {});
    }
  },
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('t') }));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import SpaceWizard from './SpaceWizard.svelte';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

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

/** Lets every pending promise and the effects after it run. */
async function settle() {
  for (let i = 0; i < 5; i++) await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

function pickPoster() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'affiche.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
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

afterAll(adoptTransitionAnimations());

beforeEach(() => {
  setLocale('fr', { reload: false });
  createSpace.mockReset();
  createSpace.mockResolvedValue({ id: 'space-1', resourceId: 'col-1' });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
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
    await settle();
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
    expect(fields.poster).toBeUndefined();
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
    await settle();
    const [, owner, hours] = createSpace.mock.calls[0];
    expect(owner).toBeNull();
    expect(hours.lines).toHaveLength(7);
  });

  it('holds the steps while the poster uploads, then carries it in the creation', async () => {
    open('assoc-1');
    pickPoster();
    await settle();
    // The upload has not answered: the next step may not open, so no creation can go without it.
    expect(button(m.bookings_wizard_next()).disabled).toBe(true);
    button(m.bookings_wizard_next()).click();
    flushSync();
    expect(heading()).toBe(m.bookings_wizard_step_what());
    upload.resolve({ mediaId: 'media-1', key: 'k', iv: 'iv', mimeType: 'image/png', size: 1 });
    await settle();
    expect(button(m.bookings_wizard_next()).disabled).toBe(false);
    button(m.bookings_wizard_next()).click();
    flushSync();
    button(m.bookings_wizard_next()).click();
    flushSync();
    button(m.bookings_tab_create_button()).click();
    await settle();
    const [, , , fields] = createSpace.mock.calls[0];
    expect(fields.poster).toMatchObject({
      type: 'image',
      mediaId: 'media-1',
      mimeType: 'image/png',
    });
  });

  it('sends the dated line of "Evenement ponctuel", and holds the step until it is dated', async () => {
    open(null);
    button(m.bookings_wizard_next()).click();
    flushSync();
    (document.querySelector('[data-template="event"]') as HTMLButtonElement).click();
    flushSync();
    // No painter for an event: its one dated line, still without a date.
    expect(document.querySelector('#wizard-date-0-start')).not.toBeNull();
    button(m.bookings_wizard_next()).click();
    flushSync();
    expect(heading()).toBe(m.bookings_section_resources());
    expect(document.body.textContent).toContain(m.bookings_wizard_problem_line());

    // The in-app date field: open it, pick the 15th of the month it shows, validate.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('40rem'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    (document.querySelector('#wizard-date-0') as HTMLButtonElement).click();
    flushSync();
    await tick();
    const days = document.querySelector('[role="dialog"] .grid') as HTMLElement;
    [...days.querySelectorAll('button')].find((b) => b.textContent?.trim() === '15')!.click();
    flushSync();
    button('Valider').click();
    flushSync();

    button(m.bookings_wizard_next()).click();
    flushSync();
    expect(heading()).toBe(m.bookings_wizard_step_who());
    button(m.bookings_tab_create_button()).click();
    await settle();
    const [, , hours] = createSpace.mock.calls[0];
    expect(hours.lines).toHaveLength(1);
    expect(hours.lines[0]).toMatchObject({ weekday: null, startTime: '14:00', endTime: '18:00' });
    expect(hours.lines[0].onDate).toMatch(/^\d{4}-\d{2}-15$/);
  });

  it('moves the focus to the step heading on Next and Back', async () => {
    open(null);
    button(m.bookings_wizard_next()).click();
    await settle();
    expect(document.activeElement?.textContent?.trim()).toBe(m.bookings_section_resources());
    button(m.common_back()).click();
    await settle();
    expect(document.activeElement?.textContent?.trim()).toBe(m.bookings_wizard_step_what());
  });

  it('"Je regle tout moi-meme" hands back the name and creates nothing', () => {
    const { onSkip } = open(null, '  Foyer ');
    button(m.bookings_wizard_skip()).click();
    expect(onSkip).toHaveBeenCalledWith('Foyer');
    expect(createSpace).not.toHaveBeenCalled();
  });

  it('"Je regle tout moi-meme" with no name makes the NAME FIELD complain, and hands back nothing', () => {
    const { onSkip } = open(null, '   ');
    button(m.bookings_wizard_skip()).click();
    flushSync();
    expect(onSkip).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(m.bookings_problem_required());
  });
});
