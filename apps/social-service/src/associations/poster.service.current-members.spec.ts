import { PosterService, keepCurrentBureaus, layoutBureauPairs } from './poster.service';
import { PosterProject } from './entities/poster-project.entity';

/**
 * A STALE EDITOR CANNOT PUT A NON-MEMBER BACK ON A MAP: a tab opened before someone left an
 * association - or before their account was erased - still holds their card, their roster entry and
 * their bureau pick. The publish and the save keep only CURRENT `association_members` rows, read in
 * one query, and say at WARN what they dropped.
 */
describe('PosterService - only current members reach a map', () => {
  const ADMIN = { userId: 'admin', isGlobalAdmin: true };
  const FP = 'b'.repeat(64);
  /** The memberships `association_members` holds: `a1` has `u1` only. */
  const MEMBERS = [{ assoId: 'a1', userId: 'u1' }];
  let queries: { sql: string; params: unknown[] }[];
  let updates: { where: unknown; patch: Record<string, unknown> }[];
  let saved: PosterProject | undefined;
  let service: PosterService;

  function repo() {
    const row = { id: 'p1', spaceId: 's1', layout: {} } as PosterProject;
    const inner = {
      update: (where: unknown, patch: Record<string, unknown>) => {
        updates.push({ where, patch });
        return Promise.resolve({ affected: 1 });
      },
      findOne: () => Promise.resolve(row),
      save: (project: PosterProject) => {
        saved = { ...project } as PosterProject;
        return Promise.resolve(project);
      },
    };
    return {
      findOne: () => Promise.resolve(row),
      manager: {
        // The associations space `s1` offers (`CARTE_SPACE_ASSOCIATIONS_SQL`).
        query: () => Promise.resolve([{ id: 'a1' }]),
        transaction: (run: (m: unknown) => Promise<unknown>) =>
          run({
            getRepository: () => inner,
            query: (sql: string, params: unknown[]) => {
              queries.push({ sql, params });
              return Promise.resolve(/association_members/.test(sql) ? MEMBERS : []);
            },
          }),
      },
    };
  }

  const entryRepo = () => ({
    find: () => Promise.resolve([{ associationId: 'a1', enabled: true }]),
  });

  const card = (userId: string) => ({ userId, name: `Name ${userId}`, role: 'Bureau' });

  /** A document with a card each for `u1` (a member) and `gone` (not one), and a roster of both. */
  function carte() {
    return {
      stage: { w: 1600, h: 1131 },
      units: [{ assoId: 'a1', cards: [card('u1'), card('gone')] }],
      texts: [],
      directory: {
        zones: [
          {
            label: 'Z',
            assos: [
              {
                assoId: 'a1',
                members: [
                  { userId: 'gone', name: 'Gone Person', role: 'Presidente' },
                  { userId: 'u1', name: 'Kept Person', role: '' },
                ],
              },
            ],
          },
        ],
      },
    };
  }

  beforeEach(() => {
    queries = [];
    updates = [];
    saved = undefined;
    service = new PosterService(repo() as never, {} as never, entryRepo() as never);
  });

  it('drops a card and a roster member of a non-member at publish, in one query under the space lock', async () => {
    const warn = jest.spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn'
    );
    await service.publish('p1', { carte: carte(), fingerprint: FP }, ADMIN);
    const patch = updates.find((u) => u.where === 'p1')!.patch;
    const published = patch.publication as ReturnType<typeof carte> & {
      directory: { zones: { assos: { line: string; members: unknown[] }[] }[] };
    };
    expect(published.units[0].cards.map((c) => c.userId)).toEqual(['u1']);
    expect(published.directory.zones[0].assos[0]).toMatchObject({
      line: 'Kept Person',
      members: [{ userId: 'u1' }],
    });
    // What went live is not what the client fingerprinted: "unknown", the editor offers an update.
    expect(patch.publicationFingerprint).toBeNull();
    expect(queries.map((q) => q.sql)).toEqual([
      expect.stringMatching(/FROM spaces .* FOR NO KEY UPDATE/),
      expect.stringMatching(/FROM association_members/),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 card(s) and 1 roster member(s)')
    );
  });

  it('keeps the fingerprint when every card is a current member', async () => {
    const doc = { ...carte(), units: [{ assoId: 'a1', cards: [card('u1')] }], directory: null };
    await service.publish('p1', { carte: doc, fingerprint: FP }, ADMIN);
    expect(updates.find((u) => u.where === 'p1')!.patch.publicationFingerprint).toBe(FP);
  });

  it('accepts a line-only directory as sent: there is no id to check', async () => {
    const doc = {
      ...carte(),
      units: [{ assoId: 'a1', cards: [] }],
      directory: { zones: [{ label: 'Z', assos: [{ assoId: 'a1', line: 'Legacy Line' }] }] },
    };
    await service.publish('p1', { carte: doc, fingerprint: FP }, ADMIN);
    const patch = updates.find((u) => u.where === 'p1')!.patch;
    expect(patch.publicationFingerprint).toBe(FP);
    expect(JSON.stringify(patch.publication)).toContain('Legacy Line');
    expect(queries.some((q) => /association_members/.test(q.sql))).toBe(false);
  });

  it("cuts a bubble's bureau to current members at save, after locking the map's row", async () => {
    const warn = jest.spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn'
    );
    const layout = {
      version: 3,
      bubbles: [{ assoId: 'a1', x: 4, selectedBureau: ['gone', 'u1'] }],
    };
    await service.update('p1', { layout }, ADMIN);
    expect(saved?.layout).toEqual({
      version: 3,
      bubbles: [{ assoId: 'a1', x: 4, selectedBureau: ['u1'] }],
    });
    expect(queries.map((q) => q.sql)).toEqual([
      expect.stringMatching(/FROM poster_projects .* FOR NO KEY UPDATE/),
      expect.stringMatching(/FROM association_members/),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 bureau pick(s)'));
  });

  it('serves a live map without its stored rosters: the account ids never leave the server', async () => {
    const live = {
      id: 'p1',
      name: 'Carte',
      publishedAt: new Date('2026-11-14T10:00:00Z'),
      publication: {
        version: 2,
        units: [{ assoId: 'a1', cards: [card('u1')] }],
        directory: {
          heading: 'Annuaire',
          zones: [
            {
              label: 'Z',
              assos: [
                {
                  assoId: 'a1',
                  line: 'Kept Person',
                  members: [{ userId: 'u1', name: 'Kept Person', role: '' }],
                },
              ],
            },
          ],
        },
      },
    };
    const reader = new PosterService(
      {
        find: () => Promise.resolve([{ id: 'p1' }]),
        findOne: () => Promise.resolve(live),
      } as never,
      {} as never,
      {} as never
    );
    const served = await reader.getSoleLegacyPublished();
    expect(served?.directory?.zones[0].assos).toEqual([{ assoId: 'a1', line: 'Kept Person' }]);
    expect(JSON.stringify(served)).not.toContain('"members"');
    // A card's `userId` is served, as it always was: the showcase keys its photos on it.
    expect(served?.units[0].cards[0].userId).toBe('u1');
    // The stored row is not rewritten by serving it.
    expect(live.publication.directory.zones[0].assos[0].members).toHaveLength(1);
  });

  it('reads the pairs of a layout defensively and returns an untouched layout as it came', () => {
    expect(
      layoutBureauPairs({
        bubbles: [null, { assoId: 'a1' }, { assoId: 'a2', selectedBureau: ['u', 3] }],
      })
    ).toEqual([{ assoId: 'a2', userId: 'u' }]);
    const layout = { bubbles: [{ assoId: 'a1', selectedBureau: ['u1'] }] };
    const out = keepCurrentBureaus(layout, () => true);
    expect(out).toEqual({ layout, dropped: 0 });
    expect(out.layout).toBe(layout);
  });
});
