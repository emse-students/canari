import { SvelteSet } from 'svelte/reactivity';
import { Log } from '$lib/utils/Log';
import { fetchBirthdaysToday, fetchMyBirthday } from './api';

/** The Paris calendar date (`YYYY-MM-DD`), the zone the server decides "today" in. */
export function parisDate(now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * WHOSE BIRTHDAY IT IS TODAY, as the reactive set every avatar reads (`Avatar.svelte` draws the ring
 * for a member in it - decision 3, docs/wiki/birthdays.md).
 *
 * The set is the SERVER's answer (`GET /api/posts/birthdays/today`): the server decides "today" from
 * its Paris date, so a device clock or zone never draws a ring on the wrong day. It is asked when the
 * account is known and again each time the app comes back to the foreground - the moment a day can
 * have turned - and held in memory only: nothing about another member's birthday is written to the
 * device, and an account switch never reads the previous account's answer.
 *
 * THE ANSWER IS PER CALENDAR DAY, so it is asked once a day: while the held answer's date is still
 * the Paris date, a return to the foreground (or a feed visit) asks nothing (owner's console export,
 * 2026-11-10: nine identical reads in five minutes). Only a new day, another account or
 * {@link BirthdaysTodayStore.invalidate} (the reader changed their own date) asks again. No clock:
 * the key is the calendar date the server itself returned. A member who enters a birthday later
 * today is drawn from tomorrow, a cost taken for the saved reads.
 *
 * A failed ask keeps the last answer for the same account (it was the server's) and says so; it is
 * never replaced by a guess.
 */
export class BirthdaysTodayStore {
  #account: string | null = null;
  readonly #ids = new SvelteSet<string>();
  #token = 0;
  /** The date of the answer held for the account, or null when none is held. */
  #answeredFor: string | null = null;

  /** Whether `userId`'s birthday is celebrated today. Reactive. */
  has(userId: string): boolean {
    return this.#ids.has(userId);
  }

  /** Drops the held answer so the next {@link refresh} asks: the reader changed their own birthday. */
  invalidate(): void {
    this.#answeredFor = null;
  }

  /**
   * Asks the server for today's celebrants as `account` sees them - unless this account already holds
   * the answer for the current Paris day.
   */
  async refresh(account: string): Promise<void> {
    if (this.#account !== account) {
      this.#account = account;
      this.#answeredFor = null;
      this.#ids.clear();
    }
    if (this.#answeredFor !== null && this.#answeredFor === parisDate()) return;
    const token = ++this.#token;
    try {
      const today = await fetchBirthdaysToday();
      if (token !== this.#token || this.#account !== account) return;
      this.#ids.clear();
      for (const id of today.userIds) this.#ids.add(id);
      this.#answeredFor = today.date;
      Log.d('birthdays', `today (${today.date}): ${today.userIds.length} celebrant(s)`);
    } catch (e) {
      Log.i(
        'birthdays',
        `today: the server could not be asked, keeping the last answer: ${String(e)}`
      );
    }
  }

  /** Forgets everything: the account signed out. */
  clear(): void {
    this.#account = null;
    this.#answeredFor = null;
    this.#token++;
    this.#ids.clear();
  }
}

/** The app's one set of today's celebrants. */
export const birthdaysToday = new BirthdaysTodayStore();

/**
 * Keeps {@link birthdaysToday} current for `account` while it is signed in: asked now, and again on
 * every return to the foreground. Returns the teardown, which forgets the set.
 */
export function followBirthdaysToday(account: string): () => void {
  const refresh = () => {
    if (document.visibilityState === 'visible') void birthdaysToday.refresh(account);
  };
  void birthdaysToday.refresh(account);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  return () => {
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('focus', refresh);
    birthdaysToday.clear();
  };
}

/**
 * WHETHER THE SIGNED-IN ACCOUNT HAS ENTERED A BIRTHDAY - the fact the one-time birthday prompt reads
 * (`components/posts/BirthdayFeedCard.svelte`). `null` is "nobody could say" (offline, an older server): the prompt
 * is then NOT shown, since inviting a member to enter a date they may have entered is a wrong
 * statement. Only the account last passed to {@link OwnBirthdayFact.load} is held.
 */
export class OwnBirthdayFact {
  #account: string | null = null;
  #hasBirthday = $state<boolean | null>(null);

  /** `true`/`false` for the loaded account, `null` while unknown. Reactive. */
  get hasBirthday(): boolean | null {
    return this.#hasBirthday;
  }

  /** Asks the server about `account`; a repeat for the same account that has an answer is a no-op. */
  async load(account: string): Promise<void> {
    if (this.#account === account && this.#hasBirthday !== null) return;
    if (this.#account !== account) {
      this.#account = account;
      this.#hasBirthday = null;
    }
    try {
      const { birthday } = await fetchMyBirthday();
      if (this.#account !== account) return;
      this.#hasBirthday = birthday !== null;
    } catch (e) {
      Log.i(
        'birthdays',
        `own birthday: the server could not be asked, the prompt waits: ${String(e)}`
      );
    }
  }

  /** The member saved or removed their date in the settings: the fact is known without asking. */
  set(account: string, hasBirthday: boolean): void {
    this.#account = account;
    this.#hasBirthday = hasBirthday;
  }
}

/** The app's one fact. */
export const ownBirthday = new OwnBirthdayFact();
