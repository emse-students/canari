import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMentionAutocomplete, type MentionUser } from './useMentionAutocomplete.svelte';

vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn().mockResolvedValue('test-token'),
  refresh: vi.fn().mockResolvedValue('test-token'),
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
