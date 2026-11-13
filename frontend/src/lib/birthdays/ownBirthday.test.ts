// @vitest-environment happy-dom
/**
 * SLOW-LINK CHANTIER, GAP 1 (2026-11-11): whether the account entered a birthday decides the feed's
 * prompt card, and its read waits for the token - at a cold start, the session refresh (4 s on the
 * owner's link). The last answer is held per account on the device and drawn at once; the server is
 * still asked, and its answer replaces it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMyBirthday } = vi.hoisted(() => ({ fetchMyBirthday: vi.fn() }));
vi.mock('./api', () => ({ fetchBirthdaysToday: vi.fn(), fetchMyBirthday }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));

import { OwnBirthdayFact } from './birthdaysToday.svelte';

describe('OwnBirthdayFact is drawn from the device first', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMyBirthday.mockReset();
  });

  it('a device that never asked knows nothing until the server answers', () => {
    fetchMyBirthday.mockReturnValue(new Promise(() => {}));
    const fact = new OwnBirthdayFact();
    void fact.load('me');
    expect(fact.hasBirthday).toBeNull();
  });

  it('the next opening holds the last answer while the network answers nothing', async () => {
    fetchMyBirthday.mockResolvedValueOnce({ birthday: null });
    await new OwnBirthdayFact().load('me');

    let answer: (value: unknown) => void = () => {};
    fetchMyBirthday.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const next = new OwnBirthdayFact();
    const loading = next.load('me');
    expect(next.hasBirthday).toBe(false);
    expect(fetchMyBirthday).toHaveBeenCalledTimes(2);
    // Entered on another device meanwhile: the answer replaces the copy.
    answer({ birthday: { day: 18, month: 7 } });
    await loading;
    expect(next.hasBirthday).toBe(true);
    expect(localStorage.getItem('canari_own_birthday:v1:me')).toBe('true');
  });

  it("never reads another account's copy, and a failed ask keeps the copy", async () => {
    new OwnBirthdayFact().set('me', true);
    fetchMyBirthday.mockRejectedValue(new TypeError('Failed to fetch'));
    const other = new OwnBirthdayFact();
    await other.load('someone-else');
    expect(other.hasBirthday).toBeNull();

    const again = new OwnBirthdayFact();
    await again.load('me');
    expect(again.hasBirthday).toBe(true);
  });
});
