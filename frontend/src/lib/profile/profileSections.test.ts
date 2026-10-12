import { describe, expect, it } from 'vitest';
import {
  PROFILE_SECTIONS,
  PROFILE_SELF_SEGMENT,
  mayOpenProfileSection,
  parseProfileSection,
  profileHubRows,
  profileSectionHref,
  profileTrail,
} from './profileSections';

const NONE = { membershipCount: null, careerCount: null, hasSponsorship: false };

describe('profile sections', () => {
  it('parses only known keys', () => {
    for (const key of PROFILE_SECTIONS) expect(parseProfileSection(key)).toBe(key);
    expect(parseProfileSection('nope')).toBeNull();
    expect(parseProfileSection(PROFILE_SELF_SEGMENT)).toBeNull();
    expect(parseProfileSection('')).toBeNull();
    expect(parseProfileSection(undefined)).toBeNull();
  });

  it('a section lives under the `me` segment so it never competes with a user id', () => {
    expect(profileSectionHref('notepad')).toBe('/profile/me/notepad');
    expect(profileSectionHref()).toBe('/profile');
  });

  it('the hub lists every section but sponsorship, which exists only with someone in the tree', () => {
    const without = profileHubRows(NONE).map((r) => r.key);
    expect(without).toEqual(PROFILE_SECTIONS.filter((k) => k !== 'sponsorship'));
    const withTree = profileHubRows({ ...NONE, hasSponsorship: true }).map((r) => r.key);
    expect(withTree).toEqual([...PROFILE_SECTIONS]);
  });

  it('the route and the hub ask the same rule', () => {
    expect(mayOpenProfileSection('sponsorship', NONE)).toBe(false);
    expect(mayOpenProfileSection('sponsorship', { ...NONE, hasSponsorship: true })).toBe(true);
    for (const key of PROFILE_SECTIONS.filter((k) => k !== 'sponsorship')) {
      expect(mayOpenProfileSection(key, NONE)).toBe(true);
    }
  });

  it('carries a summary only for a list that has loaded', () => {
    const loading = profileHubRows(NONE);
    expect(loading.every((r) => r.summary === undefined)).toBe(true);
    const loaded = profileHubRows({ ...NONE, membershipCount: 3, careerCount: 1 });
    expect(loaded.find((r) => r.key === 'associations')?.summary).toBeTruthy();
    expect(loaded.find((r) => r.key === 'career')?.summary).toBeTruthy();
    expect(loaded.find((r) => r.key === 'bio')?.summary).toBeUndefined();
  });

  it('a section path goes back to the hub, one level', () => {
    const trail = profileTrail('career', 'Profile');
    expect(trail).toHaveLength(2);
    expect(trail[0].href).toBe('/profile');
    expect(trail[1].href).toBe('/profile/me/career');
  });
});
