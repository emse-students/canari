/**
 * D44: the reminder is due from 1 September P+1 for an account whose Alumni link is EXPLICITLY
 * missing. Every date is injected; nothing here reads a clock.
 */
import { describe, expect, it } from 'vitest';
import { alumniLinkReminderDue, miconnectSourcesSettingsUrl } from './alumniLink';

const icm = (promo: number) => ({ formation: 'ICM', promo });

describe('alumniLinkReminderDue', () => {
  const unlinked = (promo: number) => ({ cursus: [icm(promo)], alumniLinked: false });

  it('starts on 1 September of the year after entry, not a day before', () => {
    expect(alumniLinkReminderDue(unlinked(2025), new Date(2026, 7, 31, 23, 59))).toBe(false);
    expect(alumniLinkReminderDue(unlinked(2025), new Date(2026, 8, 1, 0, 0))).toBe(true);
    expect(alumniLinkReminderDue(unlinked(2025), new Date(2030, 0, 1))).toBe(true);
  });

  it('never reminds a linked account, nor one whose link is unknown', () => {
    const late = new Date(2030, 0, 1);
    expect(alumniLinkReminderDue({ cursus: [icm(2020)], alumniLinked: true }, late)).toBe(false);
    expect(alumniLinkReminderDue({ cursus: [icm(2020)], alumniLinked: null }, late)).toBe(false);
    expect(alumniLinkReminderDue({ cursus: [icm(2020)] }, late)).toBe(false);
  });

  it('never reminds an account with no cursus (staff, a post only)', () => {
    expect(alumniLinkReminderDue({ cursus: [], alumniLinked: false }, new Date(2030, 0, 1))).toBe(
      false
    );
  });

  it('lets the earliest cursus decide', () => {
    const two = { cursus: [icm(2026), { formation: 'ISMIN', promo: 2024 }], alumniLinked: false };
    expect(alumniLinkReminderDue(two, new Date(2025, 8, 1))).toBe(true);
    expect(alumniLinkReminderDue(two, new Date(2025, 7, 31))).toBe(false);
  });
});

describe('miconnectSourcesSettingsUrl', () => {
  it('builds the sources page under the configured MiConnect, and nothing without one', () => {
    expect(miconnectSourcesSettingsUrl('https://auth.example/')).toBe(
      'https://auth.example/if/user/#/settings;page-sources'
    );
    expect(miconnectSourcesSettingsUrl('')).toBeNull();
  });
});
