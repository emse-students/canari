import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  attachmentFileName,
  displayNameOf,
  isSelf,
  MAIL_LIST_FILTERS,
  mailListDate,
  mailListQuery,
  sendersLine,
} from './mailFormat';

/** The list's words: a sender, a date, a search - pure, the clock a parameter. */

const SELF = ['camille.martin@etu.example.test'];

describe('senders', () => {
  it('names a person by display name, else by the local part', () => {
    expect(displayNameOf({ address: 'bde@example.test', name: ' BDE ' })).toBe('BDE');
    expect(displayNameOf({ address: 'bde@example.test', name: null })).toBe('bde');
  });

  it('the account is "moi" (any case), each person once, three names at most', () => {
    expect(isSelf({ address: 'Camille.Martin@etu.example.test', name: null }, SELF)).toBe(true);
    const line = sendersLine(
      [
        { address: 'a@example.test', name: 'Alix' },
        { address: 'camille.martin@etu.example.test', name: 'Camille' },
        { address: 'A@example.test', name: 'Alix again' },
        { address: 'b@example.test', name: 'Bastien' },
        { address: 'c@example.test', name: 'Chloé' },
      ],
      SELF
    );
    expect(line).toBe(`Alix, ${m.mail_sender_me()}, Bastien`);
    expect(sendersLine([], SELF)).toBe(m.mail_sender_unknown());
  });
});

describe('mailListDate', () => {
  const now = new Date(2026, 10, 27, 15, 0).getTime();

  it('yesterday is a word, the rest is formatted for the locale', () => {
    expect(mailListDate(new Date(2026, 10, 26, 9, 0).getTime(), now)).toBe(m.mail_date_yesterday());
    const today = mailListDate(new Date(2026, 10, 27, 9, 5).getTime(), now);
    expect(today).toMatch(/09.05/);
    const lastYear = mailListDate(new Date(2025, 0, 3).getTime(), now);
    expect(lastYear).toMatch(/2025|25/);
  });
});

describe('mailListQuery', () => {
  it("ANDs the reader's words with the filter's term", () => {
    expect(MAIL_LIST_FILTERS).toEqual(['all', 'unread', 'flagged', 'attachment']);
    expect(mailListQuery('  gala ', 'all')).toBe('gala');
    expect(mailListQuery('', 'unread')).toBe('is:unread');
    expect(mailListQuery('from:bde', 'flagged')).toBe('from:bde is:flagged');
    expect(mailListQuery('', 'attachment')).toBe('has:attachment');
  });
});

describe('attachmentFileName (review I4)', () => {
  it('reduces a stranger-written name to a bare basename', () => {
    expect(attachmentFileName('rapport.pdf')).toBe('rapport.pdf');
    expect(attachmentFileName('../../.ssh/authorized_keys')).toBe('authorized_keys');
    expect(attachmentFileName('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(attachmentFileName('note.txt:hidden')).toBe('note.txthidden');
    expect(attachmentFileName('..bashrc')).toBe('bashrc');
    expect(attachmentFileName('a\u0000b\u001fc\u007f.txt')).toBe('abc.txt');
  });

  it('gives the generic name when nothing is left', () => {
    for (const name of ['', '..', '/', 'dir/', ' . ']) {
      expect(attachmentFileName(name)).toBe(m.mail_attachment_unnamed());
    }
  });
});
