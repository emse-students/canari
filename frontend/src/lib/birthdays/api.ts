/**
 * BIRTHDAYS ON PROFILES (owner, 2026-11-08; docs/wiki/birthdays.md) - the client of social-service's
 * `/api/posts/.../birthday` routes. The day and the month only: the year is never asked, so no age
 * exists anywhere. Every read of another member's date is answered by the server's visibility rule;
 * this module holds nothing across calls and stores nothing on the device.
 */
import { socialRequest } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';

/** Who may read the date outside the day - the shared profile-field rule. FOLLOWERS by default. */
export type BirthdayVisibility = 'school' | 'followers' | 'nobody';

/** The choices, in the order the settings offer them. */
export const BIRTHDAY_VISIBILITIES: readonly BirthdayVisibility[] = [
  'school',
  'followers',
  'nobody',
];

/** What a member entered when nothing is chosen: the server's default. */
export const DEFAULT_BIRTHDAY_VISIBILITY: BirthdayVisibility = 'followers';

/** A day and a month, as stored: month 1..12, day 1..31. */
export interface BirthdayDate {
  month: number;
  day: number;
}

/** The member's own birthday, as their settings read and write it. */
export interface OwnBirthday extends BirthdayDate {
  visibility: BirthdayVisibility;
}

/**
 * Another member's birthday as the server lets the reader see it: the date only when its visibility
 * admits them, `today` whatever it says (on the day, everybody may wish it).
 */
export interface ViewedBirthday {
  birthday: BirthdayDate | null;
  today: boolean;
}

/** Today's Paris date as the server read it, and the members whose ring the reader may see. */
export interface BirthdaysToday {
  date: string;
  userIds: string[];
}

/** The typed refusal of a date no calendar has. */
export const BIRTHDAY_DATE_INVALID = 'BIRTHDAY_DATE_INVALID';

/** The caller's own birthday, or `null` when they entered none. */
export async function fetchMyBirthday(): Promise<OwnBirthday | null> {
  const { birthday } = await socialRequest<{ birthday: OwnBirthday | null }>(
    '/api/posts/me/birthday'
  );
  Log.d('birthdays', `own birthday read: ${birthday ? 'set' : 'none'}`);
  return birthday;
}

/** Writes the caller's birthday and its visibility; answers what the server stored. */
export async function saveMyBirthday(value: OwnBirthday): Promise<OwnBirthday> {
  Log.d('birthdays', `saving own birthday, visibility=${value.visibility}`);
  const { birthday } = await socialRequest<{ birthday: OwnBirthday }>('/api/posts/me/birthday', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return birthday;
}

/** Removes the caller's birthday: no date, no ring, no notice. */
export async function clearMyBirthday(): Promise<void> {
  Log.d('birthdays', 'clearing own birthday');
  await socialRequest<{ birthday: null }>('/api/posts/me/birthday', { method: 'DELETE' });
}

/** `userId`'s birthday as the reader may see it. */
export async function fetchUserBirthday(userId: string): Promise<ViewedBirthday> {
  return socialRequest<ViewedBirthday>(`/api/posts/users/${encodeURIComponent(userId)}/birthday`);
}

/** Whose birthday it is today, for the ring. */
export async function fetchBirthdaysToday(): Promise<BirthdaysToday> {
  return socialRequest<BirthdaysToday>('/api/posts/birthdays/today');
}
