/**
 * THE CREATION WIZARD'S ONE CALL (WP-R7, D52). Pinned: the payload carries only what the three
 * steps asked; fixed slots are cut from the painted hours, a tail shorter than a slot dropped and
 * none across midnight; the problems that hold a step; and the WP's proof - a space the wizard
 * creates reads back in the five sections exactly as the wizard set it.
 */
import { describe, expect, it } from 'vitest';
import type { ManagedSpace } from './api';
import { MAX_AVAILABILITY_LINES, type StoredLine } from './availability';
import { draftFromSpace, settingsFromDraft } from './spaceSettings.svelte';
import {
  fixedSlotLines,
  newWizardDraft,
  wizardPayload,
  wizardProblems,
  type WizardDraft,
} from './wizard';

const line = (weekday: number, startTime: string, endTime: string): StoredLine => ({
  weekday,
  onDate: null,
  startTime,
  endTime,
});

describe('fixedSlotLines', () => {
  it('cuts each line into slots of the length, dropping a short tail', () => {
    expect(fixedSlotLines([line(1, '14:00', '15:20')], 25)).toEqual([
      line(1, '14:00', '14:25'),
      line(1, '14:25', '14:50'),
      line(1, '14:50', '15:15'),
    ]);
  });

  it('keeps a slot ending at 24:00 and never crosses midnight', () => {
    expect(fixedSlotLines([line(5, '23:00', '24:00'), line(6, '00:00', '01:00')], 60)).toEqual([
      line(5, '23:00', '24:00'),
      line(6, '00:00', '01:00'),
    ]);
  });

  it('keeps a dated line dated', () => {
    const dated = { weekday: null, onDate: '2026-11-03', startTime: '14:00', endTime: '15:00' };
    expect(fixedSlotLines([dated], 30)).toEqual([
      { ...dated, endTime: '14:30' },
      { ...dated, startTime: '14:30' },
    ]);
  });

  it('offers nothing from a line shorter than one slot', () => {
    expect(fixedSlotLines([line(1, '10:00', '10:20')], 30)).toEqual([]);
  });
});

describe('wizardProblems', () => {
  it('lets the default draft through', () => {
    expect(wizardProblems(newWizardDraft('Salle'))).toEqual({});
  });

  it('asks for a name', () => {
    expect(wizardProblems(newWizardDraft('  ')).name).toBe('required');
  });

  it('refuses a longest booking that is not whole steps', () => {
    const d = { ...newWizardDraft('Salle'), stepMinutes: 60, maxMinutes: 90 };
    expect(wizardProblems(d).hours).toBe('duration');
  });

  it('refuses a dated line with no date', () => {
    const d: WizardDraft = {
      ...newWizardDraft('Salle'),
      rows: [{ kind: 'dated', date: '', start: '14:00', end: '18:00' }],
    };
    expect(wizardProblems(d).hours).toBe('line');
  });

  it('refuses more fixed slots than a creation carries', () => {
    // 24/7 in 30-min slots: 7 x 48 = 336 lines.
    const d: WizardDraft = {
      ...newWizardDraft('Salle'),
      rows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        kind: 'weekly' as const,
        weekday: weekday as 1,
        start: '00:00',
        end: '24:00',
      })),
      slotMode: 'slots',
      slotMinutes: 30,
    };
    expect(wizardProblems(d).hours).toBe('too-many');
    expect(MAX_AVAILABILITY_LINES).toBe(200);
    expect(wizardProblems({ ...d, slotMinutes: 120 }).hours).toBeUndefined();
  });
});

describe('wizardPayload', () => {
  it('sends the steps answers and the working week, nothing else', () => {
    const p = wizardPayload(newWizardDraft(' Salle de musique '));
    expect(p?.name).toBe('Salle de musique');
    expect(p?.fields).toEqual({
      description: null,
      slotMode: 'step',
      stepMinutes: 30,
      maxSteps: 4,
      audience: null,
      nameVisibility: 'occupied',
      discoverability: 'listed',
    });
    // Monday comes last: the week is written so (availabilityPaint `rowsOfWeek`).
    expect(p?.lines).toEqual(
      expect.arrayContaining([1, 2, 3, 4, 5].map((d) => line(d, '08:00', '20:00')))
    );
    expect(p?.lines).toHaveLength(5);
  });

  it('sends no step for fixed slots, and the slots as lines', () => {
    const p = wizardPayload({ ...newWizardDraft('Alumni'), slotMode: 'slots', slotMinutes: 60 });
    expect(p?.fields.stepMinutes).toBeUndefined();
    expect(p?.fields.maxSteps).toBeUndefined();
    expect(p?.fields.slotMode).toBe('slots');
    expect(p?.lines).toHaveLength(5 * 12);
  });

  it('sends the audience only when restricted', () => {
    const d = { ...newWizardDraft('Salle'), audience: { promo: { values: [2026] } } };
    expect(wizardPayload(d)?.fields.audience).toBeNull();
    expect(wizardPayload({ ...d, restricted: true })?.fields.audience).toEqual({
      promo: { values: [2026] },
    });
  });

  it('is null while a problem stands', () => {
    expect(wizardPayload(newWizardDraft(''))).toBeNull();
  });

  it('reads back in the five sections exactly as the wizard set it (the WP proof)', () => {
    const p = wizardPayload({
      ...newWizardDraft('Salle'),
      description: 'Piano droit',
      stepMinutes: 15,
      maxMinutes: 180,
      nameVisibility: 'names',
      discoverability: 'link',
    });
    // The server's defaults for everything the wizard does not send (booking-space.entity.ts).
    const created = {
      id: 's',
      ownerId: 'o',
      associationId: null,
      resources: [],
      poster: null,
      name: p!.name,
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
      ...p!.fields,
    } as ManagedSpace;
    const back = settingsFromDraft(draftFromSpace(created));
    expect(back).toMatchObject({ name: 'Salle', ...p!.fields });
  });
});
