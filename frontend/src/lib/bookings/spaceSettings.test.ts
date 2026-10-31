import { describe, expect, it } from 'vitest';
import type { ManagedSpace } from './api';
import { BOOKING_NOTIFICATIONS_LIVE } from './notified';
import {
  activeRuleCount,
  draftFromSpace,
  draftProblems,
  settingsFromDraft,
  timeZoneChoices,
} from './spaceSettings.svelte';

const SPACE: ManagedSpace = {
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
  reminderMinutes: 60,
};

describe('the draft round trip', () => {
  it('sends back exactly what it read, nulls kept - and never the poster, saved on its own', () => {
    const {
      id: _id,
      ownerId: _o,
      associationId: _a,
      resources: _r,
      poster: _p,
      reminderMinutes,
      ...settings
    } = SPACE;
    // The reminder default goes back only once the notices are live: off, nothing would send it.
    expect(settingsFromDraft(draftFromSpace(SPACE))).toEqual(
      BOOKING_NOTIFICATIONS_LIVE ? { ...settings, reminderMinutes } : settings
    );
  });

  it('reads an empty field as "no limit" and trims the texts to null', () => {
    const draft = { ...draftFromSpace(SPACE), horizonDays: ' ', description: '  ' };
    const out = settingsFromDraft(draft)!;
    expect(out.horizonDays).toBeNull();
    expect(out.description).toBeNull();
  });

  it('sends no step for a space of fixed slots, whatever the fields hold', () => {
    const draft = { ...draftFromSpace(SPACE), slotMode: 'slots' as const, stepMinutes: 'x' };
    expect(draftProblems(draft)).toEqual({});
    expect(settingsFromDraft(draft)).toMatchObject({ stepMinutes: null, maxSteps: null });
  });

  it('pairs the quota with its period, both or neither (the server CHECK)', () => {
    const none = settingsFromDraft(draftFromSpace(SPACE))!;
    expect([none.maxMinutesPerPeriod, none.quotaPeriod]).toEqual([null, null]);
    const set = settingsFromDraft({
      ...draftFromSpace(SPACE),
      maxMinutesPerPeriod: '120',
      quotaPeriod: 'day',
    })!;
    expect([set.maxMinutesPerPeriod, set.quotaPeriod]).toEqual([120, 'day']);
  });

  it("carries the opening instant through the SPACE's wall time, never the device's (D25)", () => {
    const opensAt = '2026-11-02T08:00:00.000Z';
    const draft = draftFromSpace({ ...SPACE, timeZone: 'Asia/Tokyo', opensAt });
    expect(draft.opensAt).toBe('2026-11-02T17:00');
    expect(settingsFromDraft(draft)!.opensAt).toBe(opensAt);
    // A new zone keeps the wall time the organiser sees, so the instant moves with it.
    expect(settingsFromDraft({ ...draft, timeZone: 'Europe/Paris' })!.opensAt).toBe(
      '2026-11-02T16:00:00.000Z'
    );
  });
});

describe('the slot length (migration 116)', () => {
  const SLOTS = { ...SPACE, slotMode: 'slots', stepMinutes: null, maxSteps: null } as const;

  it('reads a stored length back as it was', () => {
    const draft = draftFromSpace({ ...SLOTS, slotMinutes: 25 });
    expect(draft.slotMinutes).toBe('25');
    expect(settingsFromDraft(draft)).toMatchObject({ slotMode: 'slots', slotMinutes: 25 });
  });

  it('keeps a space created before it unstored: null back, the painter reads the lines', () => {
    expect(settingsFromDraft(draftFromSpace(SLOTS))).toMatchObject({ slotMinutes: null });
  });

  it('sends none on a step space, so a switch to step clears it', () => {
    const draft = { ...draftFromSpace({ ...SLOTS, slotMinutes: 25 }), slotMode: 'step' as const };
    draft.stepMinutes = '30';
    draft.maxSteps = '4';
    expect(settingsFromDraft(draft)).toMatchObject({ slotMode: 'step', slotMinutes: null });
  });
});

describe('problems, by field, before the server sees them', () => {
  it.each([
    ['stepMinutes', '4', 'range'],
    ['stepMinutes', '', 'required'],
    ['maxPeople', '51', 'range'],
    ['maxPeople', '2.5', 'range'],
    ['retentionDays', '', 'required'],
    ['retentionDays', '31', 'range'],
    ['participantWithdrawMinMinutes', '', 'required'],
  ] as const)('%s = %j -> %s', (field, value, problem) => {
    const draft = { ...draftFromSpace(SPACE), [field]: value };
    expect(draftProblems(draft)[field]).toBe(problem);
    expect(settingsFromDraft(draft)).toBeNull();
  });

  it('wants a name', () => {
    expect(draftProblems({ ...draftFromSpace(SPACE), name: ' ' })).toEqual({ name: 'required' });
  });
});

describe('the badge on the collapsed booking rules', () => {
  it('counts what is set, a zero withdrawal delay being the default', () => {
    const base = draftFromSpace(SPACE);
    expect(activeRuleCount(base)).toBe(0);
    expect(
      activeRuleCount({ ...base, horizonDays: '30', participantWithdrawMinMinutes: '60' })
    ).toBe(2);
    // The ceiling of people moved to "who" (WP-R6): it is not a collapsed rule any more.
    expect(activeRuleCount({ ...base, maxPeople: '4' })).toBe(0);
  });
});

describe('timeZoneChoices', () => {
  it('keeps the space own zone even when the engine does not list it', () => {
    expect(timeZoneChoices('Europe/Paris')).toContain('Europe/Paris');
    expect(timeZoneChoices('Mars/Olympus')[0]).toBe('Mars/Olympus');
  });
});
