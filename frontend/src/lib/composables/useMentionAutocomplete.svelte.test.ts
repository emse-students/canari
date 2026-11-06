// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMentionAutocomplete, type MentionUser } from './useMentionAutocomplete.svelte';
import type { MentionRosterMember } from '$lib/utils/users/mentionRoster';
import { flushMacrotask } from '../../test/flush';

vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn().mockResolvedValue('test-token'),
  refresh: vi.fn().mockResolvedValue('test-token'),
}));

// Who is signed in decides one of the two filters, so the tests set it rather than inherit it.
// `null` is the logged-out reading and is what every allowlist case below runs under, which is
// also why those cases still assert exactly what they did before self-exclusion existed.
let signedInAs: string | null = null;
vi.mock('$lib/stores/userState.svelte', () => ({
  currentUserId: () => signedInAs,
}));

// Names the display-name cache is told about; the batch resolver is replaceable per test.
const names = new Map<string, string>();
let resolveSpy: (ids: string[]) => Promise<void> = async () => {};
vi.mock('$lib/utils/users/displayName', () => ({
  peekUserDisplayName: (id: string) => names.get(id) ?? null,
  resolveDisplayNames: async (ids: string[]) => {
    await resolveSpy(ids);
    return (id: string) => names.get(id) ?? id;
  },
  seedUserDisplayName: () => {},
}));

// The reader's blocks are read once when a roster picker first opens; the tests set them here.
let blocked: string[] = [];
vi.mock('$lib/users/blocks', () => ({
  listBlockedUsers: async () =>
    blocked.map((userId) => ({ userId, displayName: null, createdAt: '' })),
}));

// apiFetch wraps global fetch with auth, so stubbing fetch is enough.
function makeFetchStub(results: MentionUser[]) {
  // A real Response, headers included: who answered is read from its content type.
  return vi.fn().mockImplementation(async () => Response.json(results));
}

function tick() {
  return flushMacrotask();
}

describe('useMentionAutocomplete - the server search without a roster', () => {
  let text = '';
  const setText = (newText: string) => {
    text = newText;
  };

  beforeEach(() => {
    text = '';
    signedInAs = null;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns all API suggestions when no roster is provided', async () => {
    const users: MentionUser[] = [
      { id: 'alice', displayName: 'Alice' },
      { id: 'bob', displayName: 'Bob' },
      { id: 'charlie', displayName: 'Charlie' },
    ];
    globalThis.fetch = makeFetchStub(users);

    const autocomplete = useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
    });

    autocomplete.handleEditorInput('@a', 2);
    vi.advanceTimersByTime(250);
    await tick();

    expect(autocomplete.open).toBe(true);
    expect(autocomplete.suggestions).toHaveLength(3);
    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['alice', 'bob', 'charlie']);
  });

  it('uses the server search when the roster is empty', async () => {
    globalThis.fetch = makeFetchStub([{ id: 'alice', displayName: 'Alice' }]);
    const autocomplete = useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
      roster: [],
    });

    autocomplete.handleEditorInput('@a', 2);
    vi.advanceTimersByTime(250);
    await tick();

    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['alice']);
  });
});

describe('useMentionAutocomplete - a roster is suggested locally', () => {
  let text = '';
  const setText = (newText: string) => {
    text = newText;
  };
  const day = 86_400_000;
  const roster: MentionRosterMember[] = [
    { id: 'u-marie', displayName: 'Marie Dupont', lastSpokeAt: 1 * day },
    { id: 'u-eric', displayName: 'Éric Martin', lastSpokeAt: 3 * day },
    { id: 'u-zoe', displayName: 'Zoé Bernard' },
    { id: 'u-adam', displayName: 'Adam Lemaire' },
    { id: 'u-me', displayName: 'Moi Même', lastSpokeAt: 9 * day },
  ];

  function open(opts: { roster?: MentionRosterMember[] } = { roster }) {
    return useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
      ...opts,
    });
  }

  beforeEach(() => {
    text = '';
    signedInAs = 'u-me';
    blocked = [];
    names.clear();
    resolveSpy = async () => {};
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network expected'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the whole roster on a bare @, recent speakers first then alphabetical', () => {
    const ac = open();
    ac.handleEditorInput('@', 1);
    expect(ac.open).toBe(true);
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-eric', 'u-marie', 'u-adam', 'u-zoe']);
  });

  it('filters on one letter, matching any word of the name', () => {
    const ac = open();
    ac.handleEditorInput('@m', 2);
    // Marie (first word), Eric MARTIN (second word); Moi is the reader and Adam LEMAIRE has no word
    // starting with m.
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-eric', 'u-marie']);
  });

  it('ignores accents on both sides', () => {
    const ac = open();
    ac.handleEditorInput('@er', 3);
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-eric']);
    ac.handleEditorInput('@zo', 3);
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-zoe']);
  });

  it('never offers the signed-in reader, even with the roster naming them', () => {
    const ac = open();
    ac.handleEditorInput('@', 1);
    expect(ac.suggestions.map((u) => u.id)).not.toContain('u-me');
  });

  it('never offers an account the reader blocked, once the list is read', async () => {
    blocked = ['u-eric'];
    const ac = open();
    ac.handleEditorInput('@', 1);
    await tick();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-marie', 'u-adam', 'u-zoe']);
  });

  it('makes no search request', async () => {
    const ac = open();
    ac.handleEditorInput('@m', 2);
    await tick();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('resolves the unnamed members of EACH successive roster on one instance', async () => {
    const resolved: string[][] = [];
    resolveSpy = async (ids) => {
      resolved.push(ids);
      for (const id of ids) names.set(id, 'Resolu ' + id);
    };
    const first: MentionRosterMember[] = [{ id: 'g1-a' }, { id: 'g1-b' }];
    const second: MentionRosterMember[] = [{ id: 'g2-a' }, { id: 'g1-b' }];
    let current = first;
    const ac = useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
      get roster() {
        return current;
      },
    });
    ac.handleEditorInput('@', 1);
    await tick();
    expect(ac.suggestions.map((u) => u.id).sort()).toEqual(['g1-a', 'g1-b']);
    current = second;
    ac.refreshRoster();
    await tick();
    expect(resolved).toEqual([['g1-a', 'g1-b'], ['g2-a']]);
    expect(ac.suggestions.map((u) => u.id).sort()).toEqual(['g1-b', 'g2-a']);
  });

  it('refreshes an open picker when the roster prop changes', async () => {
    let current: MentionRosterMember[] = [{ id: 'u-a', displayName: 'Ana' }];
    const ac = useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
      get roster() {
        return current;
      },
    });
    ac.handleEditorInput('@', 1);
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-a']);
    current = [{ id: 'u-b', displayName: 'Bea' }];
    ac.refreshRoster();
    expect(ac.suggestions.map((u) => u.id)).toEqual(['u-b']);
  });

  it('falls back to the server search while the roster is empty', async () => {
    globalThis.fetch = makeFetchStub([{ id: 'alice', displayName: 'Alice' }]);
    signedInAs = null;
    const ac = open({ roster: [] });
    ac.handleEditorInput('@', 1);
    expect(ac.open).toBe(false);
    ac.handleEditorInput('@a', 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(ac.suggestions.map((u) => u.id)).toEqual(['alice']);
  });
});

describe('useMentionAutocomplete - the signed-in reader is never offered', () => {
  let text = '';
  const setText = (newText: string) => {
    text = newText;
  };

  beforeEach(() => {
    text = '';
    signedInAs = null;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function suggest(opts: { roster?: MentionRosterMember[] } = {}) {
    const autocomplete = useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
      ...opts,
    });
    autocomplete.handleEditorInput('@a', 2);
    vi.advanceTimersByTime(250);
    await tick();
    return autocomplete;
  }

  const three: MentionUser[] = [
    { id: 'alice', displayName: 'Alice' },
    { id: 'bob', displayName: 'Bob' },
    { id: 'charlie', displayName: 'Charlie' },
  ];

  it('drops the reader from the suggestions', async () => {
    globalThis.fetch = makeFetchStub(three);
    signedInAs = 'bob';

    const autocomplete = await suggest();

    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['alice', 'charlie']);
  });

  // THE CONTROL FOR THE ASSERTION ABOVE. Identical inputs with nobody signed in must keep all
  // three, or "alice, charlie" would also be what a broken search, a swallowed response or an
  // unrelated filter produces - and a green row would prove nothing about the exclusion.
  it('keeps everyone when nobody is signed in', async () => {
    globalThis.fetch = makeFetchStub(three);
    signedInAs = null;

    const autocomplete = await suggest();

    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['alice', 'bob', 'charlie']);
  });

  it('matches the reader whatever case either side is stored in', async () => {
    globalThis.fetch = makeFetchStub([
      { id: 'AlIcE', displayName: 'Alice' },
      { id: 'bob', displayName: 'Bob' },
    ]);
    signedInAs = 'alice';

    const autocomplete = await suggest();

    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['bob']);
  });

  it('closes the list when the reader was the only match', async () => {
    globalThis.fetch = makeFetchStub([{ id: 'alice', displayName: 'Alice' }]);
    signedInAs = 'alice';

    const autocomplete = await suggest();

    expect(autocomplete.open).toBe(false);
    expect(autocomplete.suggestions).toHaveLength(0);
  });
});

describe('useMentionAutocomplete - Tab completes the suggestion', () => {
  let text = '';
  beforeEach(() => {
    text = '';
    signedInAs = null;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    globalThis.fetch = makeFetchStub([
      { id: 'alice', displayName: 'Alice' },
      { id: 'bob', displayName: 'Bob' },
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function opened() {
    const ac = useMentionAutocomplete({
      getText: () => text,
      setText: (t) => {
        text = t;
      },
      getCursor: () => text.length,
    });
    text = '@a';
    ac.handleEditorInput('@a', 2);
    vi.advanceTimersByTime(250);
    await tick();
    return ac;
  }
  const tab = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, ...init });

  it('picks the first suggestion when none is highlighted', async () => {
    const ac = await opened();
    const e = tab();
    expect(ac.handleKeydown(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(text).toContain('alice');
    expect(ac.open).toBe(false);
  });

  it('picks the highlighted suggestion', async () => {
    const ac = await opened();
    ac.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    ac.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    ac.handleKeydown(tab());
    expect(text).toContain('bob');
  });

  it('leaves shift+Tab and composing Tab alone', async () => {
    const ac = await opened();
    const shifted = tab({ shiftKey: true });
    expect(ac.handleKeydown(shifted)).toBe(false);
    expect(shifted.defaultPrevented).toBe(false);
    expect(ac.handleKeydown(tab({ isComposing: true }))).toBe(false);
    expect(ac.open).toBe(true);
  });

  it('leaves Tab alone when the list is closed', () => {
    const ac = useMentionAutocomplete({ getText: () => '', setText: () => {} });
    const e = tab();
    expect(ac.handleKeydown(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});
