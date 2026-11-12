// @vitest-environment happy-dom
/**
 * "@Prenom NOM" (owner, 2026-11-12): the query may hold spaces and the picker stays open for as long
 * as somebody matches the whole of it; a space that leaves nobody, Escape or a newline ends it. And
 * the server search: one request in flight, the newest query waiting, an earlier answer dropped.
 * Every name here is fictional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMentionAutocomplete, type MentionUser } from './useMentionAutocomplete.svelte';
import type { MentionRosterMember } from '$lib/utils/users/mentionRoster';
import { flushMacrotask } from '../../test/flush';

vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn().mockResolvedValue('test-token'),
  refresh: vi.fn().mockResolvedValue('test-token'),
}));
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'u-me' }));
vi.mock('$lib/utils/users/displayName', () => ({
  peekUserDisplayName: () => null,
  resolveDisplayNames: async () => (id: string) => id,
  seedUserDisplayName: () => {},
}));
vi.mock('$lib/users/blocks', () => ({ listBlockedUsers: async () => [] }));

const ROSTER: MentionRosterMember[] = [
  { id: 'u-jean', displayName: 'Jean Dupont' },
  { id: 'u-jeanne', displayName: 'Jeanne Martin' },
  { id: 'u-eloise', displayName: 'Éloïse Durand' },
];

let text = '';

function picker(roster?: MentionRosterMember[]) {
  return useMentionAutocomplete({
    getText: () => text,
    setText: (t) => {
      text = t;
    },
    getCursor: () => text.length,
    roster,
  });
}

/** Types `typed` after the current text, one character at a time, as the editor reports it. */
function typeKeys(ac: ReturnType<typeof picker>, typed: string, each?: () => void) {
  for (const ch of typed) {
    text += ch;
    ac.handleEditorInput(text, text.length);
    each?.();
  }
}

function key(k: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k });
}

beforeEach(() => {
  text = '';
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network expected'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a roster picker with several words', () => {
  it('"@Jean Dup" keeps the picker open at every key and selects Jean Dupont', () => {
    const ac = picker(ROSTER);
    typeKeys(ac, '@Jean Dup', () => expect(ac.open).toBe(true));
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean']);
    ac.select(ac.suggestions[0]);
    expect(text).toBe('@[u-jean] ');
    expect(ac.open).toBe(false);
  });

  it('"@Jean xyz" closes at the word nobody has and leaves the text as typed', () => {
    const ac = picker(ROSTER);
    typeKeys(ac, '@Jean ');
    expect(ac.open).toBe(true);
    typeKeys(ac, 'x');
    expect(ac.open).toBe(false);
    typeKeys(ac, 'yz', () => expect(ac.open).toBe(false));
    expect(text).toBe('@Jean xyz');
  });

  it('opens again when the reader backs out of the word that matched nobody', () => {
    const ac = picker(ROSTER);
    typeKeys(ac, '@Jean x');
    expect(ac.open).toBe(false);
    text = '@Jean D';
    ac.handleEditorInput(text, text.length);
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean']);
  });

  it('matches the last name first, and ignores accents', () => {
    const ac = picker(ROSTER);
    typeKeys(ac, '@dupont je');
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean']);
    text = '';
    typeKeys(ac, '@ELOISE dur');
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-eloise']);
  });

  it('Escape closes the picker, and typing on at the same @ keeps it closed', () => {
    const ac = picker(ROSTER);
    typeKeys(ac, '@Je');
    expect(ac.open).toBe(true);
    expect(ac.handleKeydown(key('Escape'))).toBe(true);
    expect(ac.open).toBe(false);
    typeKeys(ac, 'an', () => expect(ac.open).toBe(false));
  });

  it('a newline closes it', () => {
    const ac = picker(ROSTER);
    typeKeys(ac, '@Jean');
    expect(ac.open).toBe(true);
    typeKeys(ac, '\n');
    expect(ac.open).toBe(false);
  });
});

describe('the server search, with no roster', () => {
  /** Every request, with the means to answer it when the test decides. */
  let calls: { q: string; answer: (users: MentionUser[]) => void }[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn().mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          const q = new URL(url, 'https://x.invalid').searchParams.get('q') ?? '';
          calls.push({ q, answer: (users) => resolve(Response.json(users)) });
        })
    );
  });

  it('asks at once, keeps one request in flight, and sends only the newest query after it', async () => {
    const ac = picker();
    typeKeys(ac, '@jea');
    await flushMacrotask();
    // "@j" went at once; "e" and "a" waited behind it, "a" replacing "e".
    expect(calls.map((c) => c.q)).toEqual(['j']);
    calls[0].answer([{ id: 'u-x', displayName: 'Jules Exemple' }]);
    await flushMacrotask();
    // That answer was for "j", not "jea": dropped, and "jea" is asked now.
    expect(ac.open).toBe(false);
    expect(calls.map((c) => c.q)).toEqual(['j', 'jea']);
    calls[1].answer([{ id: 'u-jean', displayName: 'Jean Dupont' }]);
    await flushMacrotask();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean']);
  });

  it('keeps a multi-word query while the directory matches it, and ends it on an empty answer', async () => {
    const ac = picker();
    typeKeys(ac, '@Jean D');
    await flushMacrotask();
    calls[0].answer([]);
    await flushMacrotask();
    // "J" answered for an earlier query: "Jean D" is asked next, and it matches.
    expect(calls.at(-1)!.q).toBe('Jean D');
    calls.at(-1)!.answer([{ id: 'u-jean', displayName: 'Jean Dupont' }]);
    await flushMacrotask();
    expect(ac.open).toBe(true);
    typeKeys(ac, 'x');
    await flushMacrotask();
    calls.at(-1)!.answer([]);
    await flushMacrotask();
    expect(ac.open).toBe(false);
    const asked = calls.length;
    typeKeys(ac, 'yz');
    await flushMacrotask();
    // The mention ended: typing on asks the directory nothing more.
    expect(calls.length).toBe(asked);
  });
});
