import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMentionAutocomplete, type MentionUser } from './useMentionAutocomplete.svelte';

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

// apiFetch wraps global fetch with auth, so stubbing fetch is enough.
function makeFetchStub(results: MentionUser[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => results,
  } as Response);
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('useMentionAutocomplete - allowedUserIds filtering', () => {
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

  it('returns all API suggestions when allowedUserIds is not provided', async () => {
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

  it('filters suggestions to allowedUserIds when provided', async () => {
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
      allowedUserIds: ['bob', 'charlie'],
    });

    autocomplete.handleEditorInput('@a', 2);
    vi.advanceTimersByTime(250);
    await tick();

    expect(autocomplete.open).toBe(true);
    expect(autocomplete.suggestions).toHaveLength(2);
    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['bob', 'charlie']);
  });

  it('is case-insensitive when filtering allowedUserIds', async () => {
    const users: MentionUser[] = [
      { id: 'Alice', displayName: 'Alice' },
      { id: 'BOB', displayName: 'Bob' },
      { id: 'charlie', displayName: 'Charlie' },
    ];
    globalThis.fetch = makeFetchStub(users);

    const autocomplete = useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
      allowedUserIds: ['alice', 'bob'],
    });

    autocomplete.handleEditorInput('@a', 2);
    vi.advanceTimersByTime(250);
    await tick();

    expect(autocomplete.open).toBe(true);
    expect(autocomplete.suggestions).toHaveLength(2);
    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['Alice', 'BOB']);
  });

  it('closes the suggestion list when no allowed users match', async () => {
    const users: MentionUser[] = [{ id: 'alice', displayName: 'Alice' }];
    globalThis.fetch = makeFetchStub(users);

    const autocomplete = useMentionAutocomplete({
      getText: () => text,
      setText,
      getCursor: () => text.length,
      allowedUserIds: ['bob'],
    });

    autocomplete.handleEditorInput('@a', 2);
    vi.advanceTimersByTime(250);
    await tick();

    expect(autocomplete.open).toBe(false);
    expect(autocomplete.suggestions).toHaveLength(0);
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

  async function suggest(opts: { allowedUserIds?: string[] } = {}) {
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

  // An allowlist that CONTAINS the reader still does not offer them: the two filters are `and`,
  // not a precedence, and a channel's member list of course contains its own members.
  it('still drops the reader when the allowlist names them', async () => {
    globalThis.fetch = makeFetchStub(three);
    signedInAs = 'bob';

    const autocomplete = await suggest({ allowedUserIds: ['bob', 'charlie'] });

    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['charlie']);
  });

  // An EMPTY allowlist means "no restriction" in this composable, which is the opposite of what
  // `filterUserSuggestions` does with one. It is the reading a channel relies on before its member
  // list has loaded, so it is pinned here rather than left to the shared helper's default.
  it('treats an empty allowlist as no restriction at all', async () => {
    globalThis.fetch = makeFetchStub(three);
    signedInAs = 'bob';

    const autocomplete = await suggest({ allowedUserIds: [] });

    expect(autocomplete.suggestions.map((u) => u.id)).toEqual(['alice', 'charlie']);
  });
});
