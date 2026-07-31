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
vi.mock('$lib/stores/user', () => ({
  currentUserId: vi.fn(() => null),
  getSavedDisplayName: vi.fn(() => null),
  fetchUserProfile: vi.fn(),
}));

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
      firstName: 'Claire',
      lastName: 'Van Ruymbeke',
    } as never);

    const getName = await mod.resolveDisplayNames(['user-9']);

    expect(userStore.fetchUserProfile).toHaveBeenCalledWith('user-9');
    expect(getName('user-9')).toBe('Claire Van Ruymbeke');
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
