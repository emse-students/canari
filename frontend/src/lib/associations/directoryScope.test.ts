import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DIRECTORY AND THE CATALOGUE ARE TWO QUESTIONS, AND NEITHER MAY ANSWER FOR THE OTHER (D37).
 *
 * The server lists a reader's DIRECTORY by default (the associations reaching their spaces, plus
 * their own). Every picker and admin screen needs the whole catalogue and asks for it by name; only
 * `/associations` and `/lists` read the directory. Both go through one cache, so the key has to
 * separate them - a directory held under the catalogue's key would empty a co-organiser picker.
 */

const request = vi.fn();

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => request(...args),
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => 'tok' }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: (p: string) => p, socialUrl: (p: string) => p }));
vi.mock('$lib/utils/fileDownload', () => ({ downloadDecryptedFile: vi.fn() }));
vi.mock('$lib/stores/userState.svelte', () => ({
  setAssociationSuperAdmin: vi.fn(),
  setContentModerator: vi.fn(),
  setEventValidator: vi.fn(),
}));

/** `request` reads the body as TEXT and parses it itself, so a `json()` stub is never called. */
function ok(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** Re-imports the module so its cache starts empty for each case. */
async function freshApi() {
  vi.resetModules();
  return import('./api');
}

/** The paths requested, in order, without the base the module prefixes (unset under test). */
const paths = () =>
  request.mock.calls.map((c) => String(c[0]).slice(String(c[0]).indexOf('/api/')));

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async () => ok([]));
});

describe('association listing scopes', () => {
  it('asks the catalogue by name for a picker', async () => {
    const { listAssociations } = await freshApi();
    await listAssociations('association');
    expect(paths()).toEqual(['/api/associations?scope=all&type=association']);
  });

  it('asks the directory, with the map filter, for the directory pages', async () => {
    const { listAssociationDirectory } = await freshApi();
    await listAssociationDirectory('list');
    await listAssociationDirectory(undefined, { campus: 'gardanne', formation: 'ISMIN' });
    expect(paths()).toEqual([
      '/api/associations?scope=directory&type=list',
      '/api/associations?scope=directory&campus=gardanne&formation=ISMIN',
    ]);
  });

  it('never serves one scope from the other one held in the cache', async () => {
    const { listAssociations, listAssociationDirectory } = await freshApi();
    await listAssociations();
    await listAssociationDirectory();
    await listAssociations();
    expect(paths()).toEqual(['/api/associations?scope=all', '/api/associations?scope=directory']);
  });
});
