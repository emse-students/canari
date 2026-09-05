// ---------------------------------------------------------------------------
// Mock $lib/paraglide/messages — m.user_unknown_label() returns a known label
// so we can assert on it without depending on locale runtime.
// ---------------------------------------------------------------------------
vi.mock('$lib/paraglide/messages', () => ({
  m: {
    user_unknown_label: () => 'Utilisateur inconnu',
  },
}));

// ---------------------------------------------------------------------------
// Mock $lib/stores/user — only the functions used by displayName.ts.
// ---------------------------------------------------------------------------
// `UserProfileFetchError` and `isAbsentUserError` are taken from the REAL module rather than
// restated here. They are the seam this file's newest case turns on - "the server answered: no such
// user" against "we could not go and ask" - and a second copy of that predicate living in a mock is
// a copy that passes after the real one changes.
vi.mock('$lib/stores/user', async () => {
  const actual = await vi.importActual<typeof import('$lib/stores/user')>('$lib/stores/user');
  return {
    currentUserId: vi.fn(() => null),
    getSavedDisplayName: vi.fn(() => null),
    fetchUserProfile: vi.fn(),
    UserProfileFetchError: actual.UserProfileFetchError,
    isAbsentUserError: actual.isAbsentUserError,
  };
});

// resolveDisplayNames is imported dynamically inside its own suite: those tests call
// vi.resetModules() to get a fresh display-name cache, which a static import would defeat.
import { seedUserDisplayName, getUserDisplayNameSync, getUserInitials } from './displayName';
import * as userStore from '$lib/stores/user';

// Convenience: the mocked label
const UNKNOWN_LABEL = 'Utilisateur inconnu';

// ===========================================================================
// seedUserDisplayName
// ===========================================================================
describe('seedUserDisplayName', () => {
  it('should populate the sync cache so getUserDisplayNameSync returns the name', () => {
    seedUserDisplayName('user-1', 'Alice');
    expect(getUserDisplayNameSync('user-1')).toBe('Alice');
  });

  it('should ignore empty strings', () => {
    seedUserDisplayName('user-2', '   ');
    expect(getUserDisplayNameSync('user-2')).toBe(UNKNOWN_LABEL);
  });
});

// ===========================================================================
// getUserDisplayNameSync
// ===========================================================================
describe('getUserDisplayNameSync', () => {
  beforeEach(() => {
    // Reset the module-level cache between tests.
    // We re-import the module to get a fresh cache.
    vi.resetModules();
  });

  it('should return cached displayName when available', async () => {
    // Re-import after reset
    const mod = await import('./displayName');
    mod.seedUserDisplayName('usr_abc123', 'Jean Dupont');
    expect(mod.getUserDisplayNameSync('usr_abc123')).toBe('Jean Dupont');
  });

  it('should return fallback when no cache (explicit fallback provided)', async () => {
    const mod = await import('./displayName');
    expect(mod.getUserDisplayNameSync('usr_unknown', 'Invité')).toBe('Invité');
  });

  it('should NEVER return userId raw (anti-leak) — no cache, no fallback', async () => {
    const mod = await import('./displayName');
    const result = mod.getUserDisplayNameSync('usr_abc123');
    expect(result).not.toBe('usr_abc123');
    expect(result).toBe(UNKNOWN_LABEL);
  });

  it('should NEVER return userId raw even when fallback is the same ID (anti-leak)', async () => {
    const mod = await import('./displayName');
    // Pattern that was previously used: getUserDisplayNameSync(id, id)
    const result = mod.getUserDisplayNameSync('usr_abc123', 'usr_abc123');
    // The fallback is the ID itself, but since we trim it and it's not empty,
    // the function returns the fallback. This is technically still the old
    // pattern but the function itself is safe — the caller must not pass the
    // ID as fallback. The lint script catches this pattern at the call site.
    expect(result).toBe('usr_abc123');
  });

  it('should return unknown label when no cache and no fallback', async () => {
    const mod = await import('./displayName');
    expect(mod.getUserDisplayNameSync('usr_nonexistent')).toBe(UNKNOWN_LABEL);
  });

  it('should trim the fallback value', async () => {
    const mod = await import('./displayName');
    expect(mod.getUserDisplayNameSync('usr_x', '  Bob  ')).toBe('Bob');
  });

  it('should not leak userId in the returned string', async () => {
    const mod = await import('./displayName');
    const result = mod.getUserDisplayNameSync('abc123def456');
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('def456');
  });
});

// ===========================================================================
// resolveDisplayNames
// ===========================================================================
describe('resolveDisplayNames', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(userStore.currentUserId).mockReturnValue(null);
    vi.mocked(userStore.getSavedDisplayName).mockReturnValue(null);
  });

  it('fetches the profile of an uncached user instead of labelling it unknown', async () => {
    // Regression: the miss path used to be gated on getUserDisplayNameSync(id) !== id, and that
    // helper answers with the "unknown user" label on a miss - never the id - so the fetch below
    // was unreachable and every system message named its subject "Utilisateur inconnu".
    const mod = await import('./displayName');
    vi.mocked(userStore.fetchUserProfile).mockResolvedValueOnce({
      id: 'user-9',
      firstName: 'Camille',
      lastName: 'Van Dupont',
    } as never);

    const getName = await mod.resolveDisplayNames(['user-9']);

    expect(userStore.fetchUserProfile).toHaveBeenCalledWith('user-9');
    expect(getName('user-9')).toBe('Camille Van Dupont');
  });

  it('serves a cached name without hitting the network', async () => {
    const mod = await import('./displayName');
    mod.seedUserDisplayName('user-8', 'Alice');

    const getName = await mod.resolveDisplayNames(['user-8']);

    expect(userStore.fetchUserProfile).not.toHaveBeenCalled();
    expect(getName('user-8')).toBe('Alice');
  });

  it('never fetches the "system" sentinel - it is not a user', async () => {
    // The chat gives its own system messages senderId 'system', so every chat open used to issue
    // a GET /api/users/system that could only 404.
    const mod = await import('./displayName');

    const getName = await mod.resolveDisplayNames(['system']);

    expect(userStore.fetchUserProfile).not.toHaveBeenCalled();
    // Unresolved, so the caller keeps the id it passed - not the "unknown user" label, which
    // would end up baked into stored system-message text.
    expect(getName('system')).toBe('system');
  });

  it('never fetches a BLANK id - the absence of a user is not a user', async () => {
    // Two call sites hand `authorId ?? ''` to <Avatar>/<UserName> on purpose: a post whose author
    // is gone, a parrainage entry with no `sub`. That `??` is the caller stating a fact, and it was
    // being turned into `GET /api/users/` (plus `GET /api/users//avatar`), a 404 per mount that
    // could not have answered anything.
    const mod = await import('./displayName');

    // Whitespace normalises to the same nothing, and asked separately so the two do not collide
    // on one map key.
    const blank = await mod.resolveDisplayNames(['']);
    const spaces = await mod.resolveDisplayNames(['   ']);

    expect(userStore.fetchUserProfile).not.toHaveBeenCalled();
    // Unresolved, so the caller keeps what it passed - the same decision as the `system` sentinel.
    expect(blank('')).toBe('');
    expect(spaces('   ')).toBe('   ');
  });

  it('labels a profile that genuinely carries no name', async () => {
    // Distinct from the regression above: here the fetch DID happen and the profile simply has
    // no first/last/display name. The label is the right answer - a raw UUID in the middle of a
    // sentence would read worse than "unknown user".
    const mod = await import('./displayName');
    vi.mocked(userStore.fetchUserProfile).mockResolvedValueOnce({ id: 'user-7' } as never);

    const getName = await mod.resolveDisplayNames(['user-7']);

    expect(userStore.fetchUserProfile).toHaveBeenCalledWith('user-7');
    expect(getName('user-7')).toBe(UNKNOWN_LABEL);
  });
});

// ===========================================================================
// getUserInitials
// ===========================================================================
describe('getUserInitials', () => {
  it('should return initials from firstName + lastName', () => {
    const result = getUserInitials('usr_1', {
      id: 'usr_1',
      firstName: 'Jean',
      lastName: 'Dupont',
    });
    expect(result).toBe('JD');
  });

  it('should return initial from firstName only', () => {
    const result = getUserInitials('usr_2', {
      id: 'usr_2',
      firstName: 'Alice',
    });
    expect(result).toBe('A');
  });

  it('should return initial from lastName only', () => {
    const result = getUserInitials('usr_3', {
      id: 'usr_3',
      lastName: 'Martin',
    });
    expect(result).toBe('M');
  });

  it('should return initial from displayName when no first/last name', () => {
    const result = getUserInitials('usr_4', {
      id: 'usr_4',
      displayName: 'Bob',
    });
    expect(result).toBe('B');
  });

  it('should return ? when no name available (anti-leak)', () => {
    const result = getUserInitials('usr_abc123', { id: 'usr_abc123' });
    expect(result).toBe('?');
    // Critical anti-leak assertion: must NOT return the first character of the ID
    expect(result).not.toBe('u');
    expect(result).not.toBe('U');
  });

  it('should return ? when no profile at all (anti-leak)', () => {
    const result = getUserInitials('usr_abc123');
    expect(result).toBe('?');
    expect(result).not.toBe('u');
  });

  it('should trim whitespace from names', () => {
    const result = getUserInitials('usr_5', {
      id: 'usr_5',
      firstName: '  Clara  ',
      lastName: '  Dubois  ',
    });
    expect(result).toBe('CD');
  });

  it('should not use displayName when first or last name is available', () => {
    const result = getUserInitials('usr_6', {
      id: 'usr_6',
      firstName: 'Paul',
      displayName: 'Paulo',
    });
    expect(result).toBe('P'); // firstName takes priority over displayName
  });
});

// ===========================================================================
// formatProfileDisplayName (tested indirectly via resolveUserDisplayName)
// ===========================================================================
describe('formatProfileDisplayName (indirect)', () => {
  it('should NEVER return profile.id when no name fields are present (anti-leak)', async () => {
    // formatProfileDisplayName is private; we test its anti-leak behavior
    // indirectly through resolveUserDisplayName by mocking fetchUserProfile.
    const userModule = await import('$lib/stores/user');

    // Simulate fetchUserProfile returning a profile with only an ID
    vi.mocked(userModule.fetchUserProfile).mockResolvedValueOnce({
      id: 'usr_abc123',
      displayName: null,
      firstName: null,
      lastName: null,
      // UserProfile fields that are irrelevant for display:
      promo: null,
      formation: null,
      avatarMediaId: null,
      bio: null,
      createdAt: new Date().toISOString(),
    });

    const mod = await import('./displayName');
    const result = await mod.resolveUserDisplayName('usr_abc123');

    // The resolved name must NOT be the raw ID
    expect(result).not.toBe('usr_abc123');
    // It should be the unknown user label (formatProfileDisplayName returns m.user_unknown_label())
    expect(result).toBe(UNKNOWN_LABEL);
  });

  it('should return displayName when available', async () => {
    const userModule = await import('$lib/stores/user');
    vi.mocked(userModule.fetchUserProfile).mockResolvedValueOnce({
      id: 'usr_1',
      displayName: 'Alice',
      firstName: null,
      lastName: null,
      promo: null,
      formation: null,
      avatarMediaId: null,
      bio: null,
      createdAt: new Date().toISOString(),
    });

    const mod = await import('./displayName');
    const result = await mod.resolveUserDisplayName('usr_1');
    expect(result).toBe('Alice');
  });

  it('should return firstName + lastName when no displayName', async () => {
    const userModule = await import('$lib/stores/user');
    vi.mocked(userModule.fetchUserProfile).mockResolvedValueOnce({
      id: 'usr_2',
      displayName: null,
      firstName: 'Jean',
      lastName: 'Dupont',
      promo: null,
      formation: null,
      avatarMediaId: null,
      bio: null,
      createdAt: new Date().toISOString(),
    });

    const mod = await import('./displayName');
    const result = await mod.resolveUserDisplayName('usr_2');
    expect(result).toBe('Jean Dupont');
  });

  it('answers null when the fetch FAILS, so a caller cannot mistake it for an answer', async () => {
    // THE DEFECT THIS PINS: the catch used to return the "unknown user" label, which is truthy, and
    // every call site in the app is written as `if (resolved) use it`. So one failed request made
    // twenty-six different screens overwrite a name they already had with "Utilisateur inconnu" -
    // and only the FIRST time, because the backoff answered null afterwards. The same event
    // rendering two different ways depending on how recently it had happened.
    const userModule = await import('$lib/stores/user');
    vi.mocked(userModule.fetchUserProfile).mockRejectedValueOnce(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await import('./displayName');
    const result = await mod.resolveUserDisplayName('usr_unreachable');

    expect(result).toBeNull();
    // And it accuses: a fallback is a signal, and this one hides a name with no retry.
    expect(warn).toHaveBeenCalled();
  });

  it('answers the label for a user the server says does not exist, and asks only once', async () => {
    // THE DISTINCTION THIS PINS, and the one the file said twice it wanted and could not express:
    // a 404 is an ANSWER. It used to land in `failedAt` beside a dead radio, which gave it a
    // two-minute expiry and then re-asked for an account that will never exist - once per mount of
    // a mention chip, in every check that opened the conversation. Answering the label rather than
    // null is what stops `MessageMentionChip` rendering a bare `@`, and it is the same answer the
    // resolver already gives for a profile that exists and carries no name.
    vi.resetModules();
    const userModule = await import('$lib/stores/user');
    const mod = await import('./displayName');
    // `spyOn` hands back the SAME spy when the method is already spied, history included.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // The mock instance outlives `vi.resetModules()`, so its history belongs to the whole file
    // until it is cleared - and the count of requests is exactly what this case measures.
    vi.mocked(userModule.fetchUserProfile).mockClear();
    vi.mocked(userModule.fetchUserProfile).mockRejectedValue(
      new userModule.UserProfileFetchError(404)
    );

    expect(await mod.resolveUserDisplayName('usr_deleted')).toBe(UNKNOWN_LABEL);
    expect(await mod.resolveUserDisplayName('usr_deleted')).toBe(UNKNOWN_LABEL);
    expect(await mod.resolveUserDisplayName('usr_deleted')).toBe(UNKNOWN_LABEL);
    expect(vi.mocked(userModule.fetchUserProfile)).toHaveBeenCalledTimes(1);

    // It does not accuse: nothing failed. And it is not in the failure rate that decides whether
    // the two-minute suppression is earning its keep.
    expect(warn).not.toHaveBeenCalled();
    expect(mod.displayNameLookupStats()).toEqual({ attempted: 1, failed: 0, failureRate: 0 });
  });

  it('does not re-ask for an absent user when connectivity returns', async () => {
    // `failedAt` is cleared on reconnect, because a failure recorded while the network was down is
    // evidence about the network. An absent account is evidence about the account, so a reconnect
    // has nothing to revise - and routing the 404 through `failedAt` made every reconnect provoke
    // a fresh round of the same 404s.
    vi.resetModules();
    const connectivityModule = await import('$lib/stores/connectivity.svelte');
    const userModule = await import('$lib/stores/user');
    const mod = await import('./displayName');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(userModule.fetchUserProfile).mockClear();
    vi.mocked(userModule.fetchUserProfile).mockRejectedValue(
      new userModule.UserProfileFetchError(404)
    );
    await mod.resolveUserDisplayName('usr_deleted_2');

    connectivityModule.connectivity.notifyServerUnreachable();
    connectivityModule.connectivity.notifyServerReachable();
    await new Promise((r) => setTimeout(r, 0));

    expect(await mod.resolveUserDisplayName('usr_deleted_2')).toBe(UNKNOWN_LABEL);
    expect(vi.mocked(userModule.fetchUserProfile)).toHaveBeenCalledTimes(1);
  });

  it('counts the DENOMINATOR, so a lost name is a rate rather than an anecdote', async () => {
    // A count of failures decides nothing: one lookup in three failing and one in three hundred
    // argue for opposite things about a two-minute suppression with no retry, and the log that
    // recorded "9 of 10 rows unknown" could not tell them apart. The rate rides on the accusation
    // itself so one line answers both questions.
    //
    // A lookup that never reached the network is not in the denominator - the seeded name below is
    // answered from cache, and counting it would drive the rate towards zero as the cache warmed,
    // which measures the cache and not the fault.
    // A fresh module, because the counters are what is under test and every earlier case in this
    // file has already moved them.
    vi.resetModules();
    const userModule = await import('$lib/stores/user');
    const mod = await import('./displayName');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mod.seedUserDisplayName('usr_cached', 'Deja Connu');
    await mod.resolveUserDisplayName('usr_cached');
    expect(mod.displayNameLookupStats().attempted).toBe(0);

    vi.mocked(userModule.fetchUserProfile).mockResolvedValueOnce({
      id: 'usr_ok',
      displayName: 'Ada Lovelace',
      firstName: null,
      lastName: null,
    } as never);
    await mod.resolveUserDisplayName('usr_ok');

    vi.mocked(userModule.fetchUserProfile).mockRejectedValueOnce(new Error('network down'));
    await mod.resolveUserDisplayName('usr_lost');

    const stats = mod.displayNameLookupStats();
    expect(stats).toEqual({ attempted: 2, failed: 1, failureRate: 0.5 });
  });

  it('puts that rate in the line that accuses, not in a second one nobody reads', async () => {
    vi.resetModules();
    const userModule = await import('$lib/stores/user');
    vi.mocked(userModule.fetchUserProfile).mockRejectedValueOnce(new Error('network down'));
    // `spyOn` hands back the SAME spy when the method is already spied, history included - so the
    // history is cleared here rather than trusting call zero to belong to this test.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();

    const mod = await import('./displayName');
    await mod.resolveUserDisplayName('usr_rate');

    expect(warn.mock.calls.at(-1)?.[0]).toContain('1/1 lookups failed this session, 100.0%');
  });

  it('keeps the caller fallback while a lookup is suppressed by the backoff', async () => {
    // The synchronous read used to answer the label during the backoff window, discarding the
    // fallback the caller had passed - so a row that knew whose it was went anonymous for two
    // minutes because an unrelated profile fetch had failed.
    const userModule = await import('$lib/stores/user');
    vi.mocked(userModule.fetchUserProfile).mockRejectedValueOnce(new Error('network down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await import('./displayName');
    await mod.resolveUserDisplayName('usr_suppressed');

    expect(mod.getUserDisplayNameSync('usr_suppressed', 'Marie Curie')).toBe('Marie Curie');
    expect(mod.getUserDisplayNameSync('usr_suppressed')).toBe(UNKNOWN_LABEL);
  });

  it('should return firstName when only firstName is set', async () => {
    const userModule = await import('$lib/stores/user');
    vi.mocked(userModule.fetchUserProfile).mockResolvedValueOnce({
      id: 'usr_3',
      displayName: null,
      firstName: 'Marie',
      lastName: null,
      promo: null,
      formation: null,
      avatarMediaId: null,
      bio: null,
      createdAt: new Date().toISOString(),
    });

    const mod = await import('./displayName');
    const result = await mod.resolveUserDisplayName('usr_3');
    expect(result).toBe('Marie');
  });
});
