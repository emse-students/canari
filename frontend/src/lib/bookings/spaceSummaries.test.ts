import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import type { ManagedSpace } from './api';
import { draftFromSpace } from './spaceSettings.svelte';
import { sectionSummaries } from './spaceSummaries';

const SPACE = {
  id: 's1',
  ownerId: 'o',
  associationId: null,
  resources: [],
  poster: null,
  name: 'Salle de musique',
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

describe('the one line under each section (WP-R6, D51)', () => {
  it('reads the choices as they stand', () => {
    const s = sectionSummaries(draftFromSpace(SPACE), 1);
    expect(s.when).toBe(m.bookings_summary_when_step({ step: '30', max: '6' }));
    expect(s.who).toBe(
      [
        m.bookings_summary_audience_all(),
        m.bookings_summary_names_hidden(),
        m.bookings_summary_listed(),
        m.bookings_summary_no_question(),
      ].join(' · ')
    );
  });

  it('follows an unsaved change, and a restricted, visible, link-only space with questions', () => {
    const draft = draftFromSpace(SPACE);
    draft.audience = {};
    draft.nameVisibility = 'names';
    draft.discoverability = 'link';
    draft.items = [{ id: 'q', type: 'text' }] as never;
    const s = sectionSummaries(draft, 1);
    expect(s.who).toContain(m.bookings_summary_audience_some());
    expect(s.who).toContain(m.bookings_summary_names_visible());
    expect(s.who).toContain(m.bookings_summary_link_only());
    expect(s.who).toContain(m.bookings_summary_questions({ count: 1 }));
  });

  it('names fixed slots, and columns only from two (a hidden column says nothing)', () => {
    const draft = draftFromSpace({ ...SPACE, slotMode: 'slots' } as ManagedSpace);
    expect(sectionSummaries(draft, 1).when).toBe(m.bookings_summary_when_slots());
    expect(sectionSummaries(draft, 14).when).toBe(
      `${m.bookings_summary_when_slots()} · ${m.bookings_summary_columns({ count: 14 })}`
    );
  });

  it('does not print a half-typed step', () => {
    const draft = draftFromSpace(SPACE);
    draft.stepMinutes = '';
    expect(sectionSummaries(draft, 1).when).toBe(m.bookings_summary_when_step_any());
  });
});
