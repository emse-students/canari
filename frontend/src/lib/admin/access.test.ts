import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE DOOR AND ONE WAY IN, ASSERTED TOGETHER.
 *
 * The console admitted an association admin OR a content moderator; the dashboard offered the card
 * on the association admin alone. The case that fell between them is the third one below - a BDE
 * content moderator holding no association admin role, who could reach `/admin` by typing the URL
 * and was never shown it. These cases pin the predicate both screens now call, so the two cannot
 * answer differently again.
 */

const ensureMyAssociations = vi.fn();
const isGlobalAdmin = vi.fn();
const isContentModerator = vi.fn();

vi.mock('$lib/associations/api', () => ({ ensureMyAssociations }));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin, isContentModerator }));

const { adminScopeLabels, ensureMayOpenAdmin } = await import('./access');

beforeEach(() => {
  vi.clearAllMocks();
  isGlobalAdmin.mockReturnValue(false);
  isContentModerator.mockReturnValue(false);
  ensureMyAssociations.mockResolvedValue([]);
});

describe('ensureMayOpenAdmin', () => {
  it('admits a global admin without asking anyone', async () => {
    isGlobalAdmin.mockReturnValue(true);

    expect(await ensureMayOpenAdmin()).toBe(true);
    // A request that cannot change the answer is a request not to make.
    expect(ensureMyAssociations).not.toHaveBeenCalled();
  });

  it('admits an association admin', async () => {
    ensureMyAssociations.mockResolvedValue([
      { id: 'a', isAdmin: false },
      { id: 'b', isAdmin: true },
    ]);

    expect(await ensureMayOpenAdmin()).toBe(true);
  });

  it('admits a content moderator who administers no association', async () => {
    // THE CASE THAT FELL BETWEEN THE TWO SCREENS.
    ensureMyAssociations.mockResolvedValue([{ id: 'a', isAdmin: false }]);
    isContentModerator.mockReturnValue(true);

    expect(await ensureMayOpenAdmin()).toBe(true);
  });

  it('refuses a member who is neither', async () => {
    ensureMyAssociations.mockResolvedValue([{ id: 'a', isAdmin: false }]);

    expect(await ensureMayOpenAdmin()).toBe(false);
  });

  it('refuses when the probe answered nothing, which is how it reports a failure', async () => {
    ensureMyAssociations.mockResolvedValue([]);

    expect(await ensureMayOpenAdmin()).toBe(false);
  });
});

describe('adminScopeLabels', () => {
  it('does not call the console "Administration" for a reader who only moderates', () => {
    // The whole point: the heading stops promising a platform console it does not deliver.
    expect(adminScopeLabels(false).title()).not.toBe(adminScopeLabels(true).title());
  });

  it('pairs each heading with the description that was already telling the truth', () => {
    const moderator = adminScopeLabels(false);
    const global = adminScopeLabels(true);

    // Chosen together, from one predicate: a heading and a subtitle that branch separately are two
    // places to change and one to forget.
    expect(moderator.description()).not.toBe(global.description());
    for (const scope of [moderator, global]) {
      expect(scope.title().length).toBeGreaterThan(0);
      expect(scope.description().length).toBeGreaterThan(0);
    }
  });
});
