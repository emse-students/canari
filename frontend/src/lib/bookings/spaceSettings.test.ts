import { describe, expect, it } from 'vitest';
import type { ManagedSpace } from './api';
import {
  activeRuleCount,
  draftFromSpace,
  draftProblems,
  settingsFromDraft,
  timeZoneChoices,
} from './spaceSettings';

const SPACE: ManagedSpace = {
  id: 's1',
  ownerId: 'o',
  associationId: null,
  resources: [],
  name: 'Salle de musique',
  description: null,
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 30,
  maxSteps: 4,
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

describe('the draft round trip', () => {
  it('sends back exactly what it read, nulls kept', () => {
    const { id: _id, ownerId: _o, associationId: _a, resources: _r, ...settings } = SPACE;
    expect(settingsFromDraft(draftFromSpace(SPACE))).toEqual(settings);
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
  });
});

describe('timeZoneChoices', () => {
  it('keeps the space own zone even when the engine does not list it', () => {
    expect(timeZoneChoices('Europe/Paris')).toContain('Europe/Paris');
    expect(timeZoneChoices('Mars/Olympus')[0]).toBe('Mars/Olympus');
  });
});
