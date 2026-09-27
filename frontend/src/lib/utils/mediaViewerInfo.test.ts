/**
 * The media viewer's date title and information-panel lines (`mediaViewerInfo.ts`), ported from
 * MiGallery's viewer with its tests.
 *
 * The clock and the zone are pinned (Europe/Paris, 2026-09-25 at 12:00 local) so "today" /
 * "yesterday" and the dropped year are deterministic; the day boundary is the one in Paris, not UTC.
 */

import { describe, it, expect } from 'vitest';
import {
  dimensionsParts,
  formatViewerDateTitle,
  formatViewerFullDate,
} from '$lib/utils/mediaViewerInfo';

const labels = { today: "Aujourd'hui", yesterday: 'Hier' };
const fr = {
  locale: 'fr',
  labels,
  now: new Date('2026-09-25T10:00:00Z'),
  timeZone: 'Europe/Paris',
};

describe('formatViewerDateTitle', () => {
  it('names today and yesterday, with the time on its own line', () => {
    expect(formatViewerDateTitle('2026-09-25T12:03:00Z', fr)).toEqual({
      date: "Aujourd'hui",
      time: '14:03',
    });
    expect(formatViewerDateTitle('2026-09-24T21:59:00Z', fr)).toEqual({
      date: 'Hier',
      time: '23:59',
    });
  });

  it('draws the day boundary in the local zone, not in UTC', () => {
    // 22:30 UTC on the 24th is 00:30 on the 25th in Paris.
    expect(formatViewerDateTitle('2026-09-24T22:30:00Z', fr)).toEqual({
      date: "Aujourd'hui",
      time: '00:30',
    });
  });

  it('writes an older date in French, and the year only when it is not the current one', () => {
    expect(formatViewerDateTitle('2026-09-18T12:03:00Z', fr)).toEqual({
      date: 'ven. 18 sept.',
      time: '14:03',
    });
    expect(formatViewerDateTitle('2025-02-03T08:05:00Z', fr)).toEqual({
      date: 'lun. 3 févr. 2025',
      time: '09:05',
    });
  });

  it('accepts the Date a message carries and the millisecond count a post may carry', () => {
    const at = new Date('2026-09-18T12:03:00Z');
    expect(formatViewerDateTitle(at, fr)).toEqual(formatViewerDateTitle(at.getTime(), fr));
  });

  it('follows the locale it is given', () => {
    const en = formatViewerDateTitle('2026-09-18T12:03:00Z', { ...fr, locale: 'en' });
    expect(en?.date).toBe('Fri, Sep 18');
    expect(en?.time).toMatch(/^02:03\sPM$/);
  });

  it('returns null for a missing or unparseable date instead of "Invalid Date"', () => {
    expect(formatViewerDateTitle(null, fr)).toBeNull();
    expect(formatViewerDateTitle('', fr)).toBeNull();
    expect(formatViewerDateTitle('not a date', fr)).toBeNull();
  });
});

describe('formatViewerFullDate', () => {
  it('is never relative', () => {
    expect(formatViewerFullDate('2025-02-03T08:05:00Z', 'fr', 'Europe/Paris')).toBe(
      'lundi 3 février 2025 à 09:05'
    );
    expect(formatViewerFullDate('bad', 'fr', 'Europe/Paris')).toBeNull();
  });
});

describe('dimensionsParts', () => {
  it('gives the pixel size and the megapixels in the locale separator', () => {
    expect(dimensionsParts(4032, 3024, 'en')).toEqual({
      width: 4032,
      height: 3024,
      megapixels: '12.2',
    });
    expect(dimensionsParts(4032, 3024, 'fr')?.megapixels).toBe('12,2');
  });

  it('is null when a side is unknown', () => {
    expect(dimensionsParts(4032, undefined, 'en')).toBeNull();
    expect(dimensionsParts(0, 3024, 'en')).toBeNull();
  });
});
