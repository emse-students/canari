// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteReaderSpaces, readerSpacesFingerprint, saveUserLocally } from './user';
import { registerPerReaderCache } from '$lib/utils/sharedCache';

/**
 * WHAT IS HELD ABOUT THE READER IS FORGOTTEN WHEN THEIR CAMPUS OR CURSUS CHANGES, AND ONLY THEN.
 *
 * The directory, the shop, the partnerships and the agenda are scoped by the reader's spaces (D16,
 * D37), in per-reader caches. A campus corrected by an admin, or changed in MiConnect, used to be
 * drawn with the old campus until each cache expired. The change is found by comparing the profile
 * to the one last recorded - durable state - never by the age of what is held.
 */
describe('noteReaderSpaces', () => {
  const forgotten = vi.fn();
  registerPerReaderCache(forgotten);

  const icm = { campus: 'saint-etienne' as const, cursus: [{ formation: 'ICM', promo: 2024 }] };

  beforeEach(() => {
    localStorage.clear();
    saveUserLocally({ id: 'reader' });
    forgotten.mockClear();
  });

  it('only records on the first reading of an account: nothing to compare against yet', () => {
    noteReaderSpaces(icm);
    expect(forgotten).not.toHaveBeenCalled();
  });

  it('forgets nothing when the campus and cursus are unchanged', () => {
    noteReaderSpaces(icm);
    noteReaderSpaces({ ...icm, cursus: [...icm.cursus] });
    expect(forgotten).not.toHaveBeenCalled();
  });

  it('forgets everything held about the reader when the campus changes', () => {
    noteReaderSpaces(icm);
    noteReaderSpaces({ ...icm, campus: 'gardanne' });
    expect(forgotten).toHaveBeenCalledTimes(1);
  });

  it('forgets everything held about the reader when the cursus changes', () => {
    noteReaderSpaces(icm);
    noteReaderSpaces({ ...icm, cursus: [...icm.cursus, { formation: 'ISMIN', promo: 2024 }] });
    expect(forgotten).toHaveBeenCalledTimes(1);
  });

  it('reads the cursus as a set: the same entries in another order are no change', () => {
    const two = [
      { formation: 'ICM', promo: 2024 },
      { formation: 'ISMIN', promo: 2025 },
    ];
    expect(readerSpacesFingerprint({ campus: 'gardanne', cursus: two })).toBe(
      readerSpacesFingerprint({ campus: 'gardanne', cursus: [...two].reverse() })
    );
  });

  it('does not compare one account against the previous one', () => {
    noteReaderSpaces(icm);
    // The switch itself forgets everything (saveUserLocally); the new account's first reading
    // then only records.
    saveUserLocally({ id: 'someone-else' });
    forgotten.mockClear();
    noteReaderSpaces({ ...icm, campus: 'gardanne' });
    expect(forgotten).not.toHaveBeenCalled();
  });
});
