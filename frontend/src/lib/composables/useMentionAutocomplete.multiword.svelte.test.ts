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
/** Names the display-name cache knows, and a batch the test answers when it decides (B1 below). */
const names = vi.hoisted(() => ({
  known: new Map<string, string>(),
  pending: [] as { ids: string[]; land: (named: Record<string, string>) => void }[],
}));
vi.mock('$lib/utils/users/displayName', () => ({
  peekUserDisplayName: (id: string) => names.known.get(id) ?? null,
  resolveDisplayNames: (ids: string[]) =>
    new Promise<void>((resolve) => {
      names.pending.push({
        ids,
        land: (named) => {
          for (const [id, name] of Object.entries(named)) names.known.set(id, name);
          resolve();
        },
      });
    }),
  seedUserDisplayName: () => {},
}));
/** The reader's blocks, as the next read answers them. */
const blocks = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('$lib/users/blocks', () => ({
  listBlockedUsers: async () => blocks.ids.map((userId) => ({ userId })),
}));

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
  names.known.clear();
  names.pending = [];
  blocks.ids = [];
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

describe('review of #3402', () => {
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

  it('B1: a space typed before the roster names land does not end the mention for good', async () => {
    const ac = picker([{ id: 'u-camille', displayName: null }, ...ROSTER]);
    typeKeys(ac, '@Camille ');
    // The batch has not answered: nobody is named Camille yet, the space found nobody.
    expect(ac.open).toBe(false);
    expect(names.pending).toHaveLength(1);
    names.pending[0].land({ 'u-camille': 'Camille Exemple' });
    await flushMacrotask();
    expect(ac.open).toBe(true);
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-camille']);
    typeKeys(ac, 'Ex');
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-camille']);
  });

  it('B2, roster: a sentence after a name closes the picker and Enter reaches the composer', () => {
    const roster: MentionRosterMember[] = [
      ...ROSTER,
      { id: 'u-marie', displayName: 'Marie Exemple' },
    ];
    for (const sentence of ['@Jean je le', '@Jean a dit', '@Marie et toi']) {
      text = '';
      const ac = picker(roster);
      typeKeys(ac, sentence);
      expect(ac.open, sentence).toBe(false);
      expect(ac.handleKeydown(key('Enter')), sentence).toBe(false);
      expect(ac.handleKeydown(key('Tab')), sentence).toBe(false);
      expect(text).toBe(sentence);
    }
  });

  it('B2, server: rows the directory matched only by substrings do not keep a sentence open', async () => {
    const directory: Record<string, MentionUser[]> = {
      'Jean je le': [{ id: 'u-jean', displayName: 'Jean Dupont' }],
      'Jean a dit': [{ id: 'u-jean', displayName: 'Jean Dupont' }],
      'Marie et toi': [{ id: 'u-marie', displayName: 'Marie Exemple' }],
    };
    for (const sentence of Object.keys(directory)) {
      text = '';
      calls = [];
      const ac = picker();
      // Pasted in one go, so the one request is for the whole sentence.
      text = `@${sentence}`;
      ac.handleEditorInput(text, text.length);
      await flushMacrotask();
      expect(calls.map((c) => c.q)).toEqual([sentence]);
      calls[0].answer(directory[sentence]);
      await flushMacrotask();
      expect(ac.open, sentence).toBe(false);
      expect(ac.handleKeydown(key('Enter')), sentence).toBe(false);
      expect(ac.handleKeydown(key('Tab')), sentence).toBe(false);
      expect(text).toBe(`@${sentence}`);
    }
  });

  it('hides the rows of an earlier query while the new one is asked, so Tab cannot pick one', async () => {
    const ac = picker();
    typeKeys(ac, '@J');
    await flushMacrotask();
    calls[0].answer([{ id: 'u-jules', displayName: 'Jules Exemple' }]);
    await flushMacrotask();
    expect(ac.open).toBe(true);
    typeKeys(ac, 'ea');
    expect(ac.open).toBe(false);
    expect(ac.suggestions).toEqual([]);
    expect(ac.handleKeydown(key('Tab'))).toBe(false);
  });

  /** A live picker whose roster the test swaps, as a chat line does. */
  function livePicker(initial: MentionRosterMember[]) {
    let roster = initial;
    const ac = useMentionAutocomplete({
      getText: () => text,
      setText: (t) => {
        text = t;
      },
      getCursor: () => text.length,
      get roster() {
        return roster;
      },
      audienceFilter: async (users) => users,
    });
    return {
      ac,
      swap(next: MentionRosterMember[]) {
        roster = next;
        ac.refreshRoster();
      },
    };
  }

  it('a newcomer posting while a search is on its way keeps the waiting query and the top-up', async () => {
    const { ac, swap } = livePicker(ROSTER);
    typeKeys(ac, '@Je');
    await flushMacrotask();
    // "J" is in flight, "Je" waits behind it.
    expect(calls.map((c) => c.q)).toEqual(['J']);
    swap([...ROSTER.map((m) => ({ ...m })), { id: 'u-newcomer', displayName: 'Zed Exemple' }]);
    calls[0].answer([]);
    await flushMacrotask();
    expect(calls.map((c) => c.q)).toEqual(['J', 'Je']);
    calls[1].answer([{ id: 'u-jeff', displayName: 'Jeff Exemple' }]);
    await flushMacrotask();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean', 'u-jeanne', 'u-jeff']);
  });

  it('the same members reordered keep the waiting query', async () => {
    const { ac, swap } = livePicker(ROSTER);
    typeKeys(ac, '@Je');
    await flushMacrotask();
    swap([...ROSTER].reverse());
    calls[0].answer([]);
    await flushMacrotask();
    expect(calls.map((c) => c.q)).toEqual(['J', 'Je']);
  });

  it('a roster change keeps the rows the audience added and the row the reader selected', async () => {
    const { ac, swap } = livePicker(ROSTER);
    typeKeys(ac, '@J');
    await flushMacrotask();
    calls[0].answer([{ id: 'u-jeff', displayName: 'Jeff Exemple' }]);
    await flushMacrotask();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean', 'u-jeanne', 'u-jeff']);
    ac.handleKeydown(key('ArrowDown'));
    ac.handleKeydown(key('ArrowDown'));
    ac.handleKeydown(key('ArrowDown'));
    expect(ac.suggestions[ac.selectedIdx].id).toBe('u-jeff');
    // A chat line: a newcomer whose name also starts with J, the rest reordered.
    swap([{ id: 'u-jules', displayName: 'Jules Exemple' }, ...[...ROSTER].reverse()]);
    expect(ac.suggestions.map((u) => u.id)).toContain('u-jeff');
    expect(ac.suggestions.map((u) => u.id)).toContain('u-jules');
    expect(ac.suggestions[ac.selectedIdx].id).toBe('u-jeff');
  });

  it('a search answered with an error status warns, once per outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
    const ac = picker();
    typeKeys(ac, '@ab');
    await flushMacrotask();
    await flushMacrotask();
    typeKeys(ac, 'c');
    await flushMacrotask();
    const failures = warn.mock.calls.filter((c) => String(c[0]).includes('the name search failed'));
    expect(failures).toHaveLength(1);
    expect(String(failures[0][1])).toBe('HTTP 503');
    expect(ac.open).toBe(false);
  });

  it('an empty-roster search, then the roster loads: the answer is dropped and the members stay', async () => {
    let roster: MentionRosterMember[] = [];
    const ac = useMentionAutocomplete({
      getText: () => text,
      setText: (t) => {
        text = t;
      },
      getCursor: () => text.length,
      get roster() {
        return roster;
      },
    });
    typeKeys(ac, '@Je');
    await flushMacrotask();
    // No member yet: the directory is asked, "J" in flight and "Je" waiting.
    expect(calls.map((c) => c.q)).toEqual(['J']);
    roster = ROSTER;
    ac.refreshRoster();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean', 'u-jeanne']);
    calls[0].answer([{ id: 'u-outsider', displayName: 'Jo Ailleurs' }]);
    await flushMacrotask();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean', 'u-jeanne']);
    // The waiting directory query is moot now: never sent.
    expect(calls).toHaveLength(1);
    ac.handleKeydown(key('ArrowDown'));
    ac.handleKeydown(key('Enter'));
    expect(text).toBe('@[u-jean] ');
  });

  it('a block list that answers after the top-up landed removes the blocked row from it', async () => {
    const { ac, swap } = livePicker(ROSTER);
    typeKeys(ac, '@J');
    await flushMacrotask();
    calls[0].answer([{ id: 'u-jeff', displayName: 'Jeff Exemple' }]);
    await flushMacrotask();
    expect(ac.suggestions.map((u) => u.id)).toContain('u-jeff');
    blocks.ids = ['U-JEFF'];
    // A chat line re-sends the roster; its preparation reads the blocks again.
    swap(ROSTER.map((m) => ({ ...m })));
    await flushMacrotask();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-jean', 'u-jeanne']);
  });

  it('applies nothing once disposed, and sends nothing that was waiting', async () => {
    const ac = picker();
    typeKeys(ac, '@Je');
    await flushMacrotask();
    expect(calls.map((c) => c.q)).toEqual(['J']);
    ac.dispose();
    calls[0].answer([{ id: 'u-jean', displayName: 'Jean Dupont' }]);
    await flushMacrotask();
    expect(ac.open).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('F1: a name batch landing after Escape does not reopen the picker, and Enter reaches the composer', async () => {
    const ac = picker([{ id: 'u-camille', displayName: null }, ...ROSTER]);
    typeKeys(ac, '@J');
    expect(ac.open).toBe(true);
    expect(names.pending).toHaveLength(1);
    expect(ac.handleKeydown(key('Escape'))).toBe(true);
    names.pending[0].land({ 'u-camille': 'Camille Exemple' });
    await flushMacrotask();
    expect(ac.open).toBe(false);
    expect(ac.handleKeydown(key('Enter'))).toBe(false);
  });

  it('F2: the same members in a new array keep the answer on its way and the waiting query', async () => {
    let roster: MentionRosterMember[] = ROSTER;
    const ac = useMentionAutocomplete({
      getText: () => text,
      setText: (t) => {
        text = t;
      },
      getCursor: () => text.length,
      get roster() {
        return roster;
      },
      audienceFilter: async (users) => users,
    });
    typeKeys(ac, '@Je');
    await flushMacrotask();
    expect(calls.map((c) => c.q)).toEqual(['J']);
    // A busy live chat: every line rebuilds the roster, same members.
    roster = ROSTER.map((m) => ({ ...m }));
    ac.refreshRoster();
    roster = ROSTER.map((m) => ({ ...m }));
    ac.refreshRoster();
    calls[0].answer([]);
    await flushMacrotask();
    expect(calls.map((c) => c.q)).toEqual(['J', 'Je']);
    calls[1].answer([{ id: 'u-jeff', displayName: 'Jeff Exemple' }]);
    await flushMacrotask();
    expect(ac.suggestions.map((u) => u.id)).toContain('u-jeff');
  });

  it('warns once per outage, not once per key typed while offline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failures = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes('the name search failed')).length;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
    const ac = picker();
    typeKeys(ac, '@abc');
    await flushMacrotask();
    await flushMacrotask();
    typeKeys(ac, 'd');
    await flushMacrotask();
    expect(failures()).toBe(1);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json([{ id: 'u-x', displayName: 'Abcde Exemple' }]));
    typeKeys(ac, 'e');
    await flushMacrotask();
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
    typeKeys(ac, 'f');
    await flushMacrotask();
    expect(failures()).toBe(2);
  });
});
