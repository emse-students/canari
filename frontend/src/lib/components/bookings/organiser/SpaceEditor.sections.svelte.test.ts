// @vitest-environment happy-dom
/**
 * THE FIVE SECTIONS IN PLAIN WORDS (WP-R6, D51, Q-R13). Pinned: the five titles are the questions
 * decided, each section carries its current answer on a line under the title and follows an unsaved
 * change; the people ceiling and the after-booking information sit in "who", not in "General" or
 * the collapsed rules; the two last sections start closed, the data one with its retention badge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/navigation/unsavedChanges', () => ({
  guardUnsavedChanges: () => ({ release: () => {} }),
}));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { ManagedSpace } from '$lib/bookings/api';
import SpaceEditor from './SpaceEditor.svelte';

const SPACE = {
  id: 's1',
  ownerId: 'o',
  associationId: null,
  resources: [
    {
      id: 'r1',
      name: 'Salle',
      description: null,
      privateInfo: null,
      linkedUserId: null,
      position: 0,
      lines: [],
      exceptions: [],
    },
  ],
  poster: null,
  name: 'Salle',
  description: null,
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 30,
  maxSteps: 6,
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
} as unknown as ManagedSpace;

const mounted: ReturnType<typeof mount>[] = [];

function open() {
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
}

/** The line under a section's title: the paragraph after its header (a button or a row). */
function summaryOf(sec: HTMLElement): Element | null {
  return sec.querySelector('[id$="-summary"]');
}

/** The `<section>` whose title is `title`. */
function section(title: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('section')].find((s) =>
    s.querySelector('h2')?.textContent?.trim().startsWith(title)
  );
  if (!found) throw new Error(`no section "${title}"`);
  return found;
}

beforeEach(() => setLocale('fr', { reload: false }));

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('SpaceEditor - the five sections in plain words', () => {
  it('titles the sections as the decided questions, each with its line', () => {
    open();
    for (const title of [
      m.bookings_section_general(),
      m.bookings_section_resources(),
      m.bookings_section_who(),
      m.bookings_section_rules(),
      m.bookings_section_data(),
    ]) {
      expect(summaryOf(section(title))?.textContent?.trim()).toBeTruthy();
    }
    expect(section(m.bookings_section_resources()).textContent).toContain(
      m.bookings_summary_when_step({ step: '30', max: '6' })
    );
  });

  it('keeps the summary outside the header button, which it describes', () => {
    open();
    const rules = section(m.bookings_section_rules());
    const button = rules.querySelector('button[aria-expanded]')!;
    const line = rules.querySelector('h2 ~ p, button + p')!;
    expect(button.contains(line)).toBe(false);
    expect(button.querySelector('div, p')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBe(line.id);
  });

  it('puts the people ceiling and the after-booking information in "who", nowhere else', () => {
    open();
    const who = section(m.bookings_section_who());
    expect(who.querySelector('#space-max-people')).not.toBeNull();
    expect(who.querySelector('#space-private')).not.toBeNull();
    expect(section(m.bookings_section_general()).querySelector('#space-private')).toBeNull();
    expect(section(m.bookings_section_rules()).querySelector('#space-max-people')).toBeNull();
  });

  it('follows an unsaved change in the line under the title', () => {
    open();
    const who = section(m.bookings_section_who());
    expect(summaryOf(who)?.textContent).toContain(m.bookings_summary_names_hidden());
    const visible = [...who.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.bookings_names_names()
    )!;
    visible.click();
    flushSync();
    expect(summaryOf(who)?.textContent).toContain(m.bookings_summary_names_visible());
  });

  it('starts the rules and the data sections closed, the data one with its retention', () => {
    open();
    const data = section(m.bookings_section_data());
    expect(data.textContent).toContain(m.bookings_retention_badge({ days: '7' }));
    expect(data.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(
      section(m.bookings_section_rules())
        .querySelector('button[aria-expanded]')
        ?.getAttribute('aria-expanded')
    ).toBe('false');
  });
});
