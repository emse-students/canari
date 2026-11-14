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
  /** An association of the space: ids are uuids, as the membership query compares them. */
  const A1 = '00000000-0000-4000-8000-0000000000a1';
  /** The memberships `association_members` holds: `A1` has `u1` only. */
  const MEMBERS = [{ assoId: A1, userId: 'u1' }];
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
        query: () => Promise.resolve([{ id: A1 }]),
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
    find: () => Promise.resolve([{ associationId: A1, enabled: true }]),
  });

  const card = (userId: string) => ({ userId, name: `Name ${userId}`, role: 'Bureau' });

  /** A document with a card each for `u1` (a member) and `gone` (not one), and a roster of both. */
  function carte() {
    return {
      stage: { w: 1600, h: 1131 },
      units: [{ assoId: A1, cards: [card('u1'), card('gone')] }],
      texts: [],
      directory: {
        zones: [
          {
            label: 'Z',
            assos: [
              {
                assoId: A1,
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
    const doc = { ...carte(), units: [{ assoId: A1, cards: [card('u1')] }], directory: null };
    await service.publish('p1', { carte: doc, fingerprint: FP }, ADMIN);
    expect(updates.find((u) => u.where === 'p1')!.patch.publicationFingerprint).toBe(FP);
  });

  // A line with no roster names people by name only: the server could neither check it nor scrub an
  // erased account out of it, so it is refused - a stale or old editor is told to reload.
  it('refuses a directory line with no roster, typed, and writes nothing', async () => {
    const doc = {
      ...carte(),
      units: [{ assoId: A1, cards: [] }],
      directory: {
        zones: [
          {
            label: 'Z',
            assos: [
              { assoId: A1, line: 'Legacy Line' },
              // An entry naming nobody is no roster to check, and passes.
              { assoId: A1, line: '' },
            ],
          },
        ],
      },
    };
    await expect(
      service.publish('p1', { carte: doc, fingerprint: FP }, ADMIN)
    ).rejects.toMatchObject({ response: { code: 'CARTE_ROSTER_UNSTRUCTURED' } });
    expect(updates).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('accepts a directory entry that names nobody, with no roster', async () => {
    const doc = {
      ...carte(),
      units: [{ assoId: A1, cards: [] }],
      directory: { zones: [{ label: 'Z', assos: [{ assoId: A1, line: '' }] }] },
    };
    await service.publish('p1', { carte: doc, fingerprint: FP }, ADMIN);
    expect(updates.find((u) => u.where === 'p1')!.patch.publicationFingerprint).toBe(FP);
  });

  it('reads the memberships by uuid and LOCKS them, skipping an association id that is no uuid', async () => {
    const layout = {
      bubbles: [
        { assoId: A1, selectedBureau: ['u1'] },
        { assoId: 'not-a-uuid', selectedBureau: ['u1'] },
      ],
    };
    await service.update('p1', { layout }, ADMIN);
    const membership = queries.find((q) => /association_members/.test(q.sql))!;
    expect(membership.sql).toMatch(/"associationId" = ANY\(\$1::uuid\[\]\)/);
    expect(membership.sql).toMatch(/FOR KEY SHARE/);
    expect(membership.params).toEqual([[A1], ['u1']]);
    // A pick under an association that cannot be one is not a membership: dropped.
    expect(saved?.layout).toEqual({
      bubbles: [
        { assoId: A1, selectedBureau: ['u1'] },
        { assoId: 'not-a-uuid', selectedBureau: [] },
      ],
    });
  });

  it("cuts a bubble's bureau to current members at save, after locking the map's row", async () => {
    const warn = jest.spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn'
    );
    const layout = {
      version: 3,
      bubbles: [{ assoId: A1, x: 4, selectedBureau: ['gone', 'u1'] }],
    };
    await service.update('p1', { layout }, ADMIN);
    expect(saved?.layout).toEqual({
      version: 3,
      bubbles: [{ assoId: A1, x: 4, selectedBureau: ['u1'] }],
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
        units: [{ assoId: A1, cards: [card('u1')] }],
        directory: {
          heading: 'Annuaire',
          zones: [
            {
              label: 'Z',
              assos: [
                {
                  assoId: A1,
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
    expect(served?.directory?.zones[0].assos).toEqual([{ assoId: A1, line: 'Kept Person' }]);
    expect(JSON.stringify(served)).not.toContain('"members"');
    // A card's `userId` is served, as it always was: the showcase keys its photos on it.
    expect(served?.units[0].cards[0].userId).toBe('u1');
    // The stored row is not rewritten by serving it.
    expect(live.publication.directory.zones[0].assos[0].members).toHaveLength(1);
  });

  it('reads the pairs of a layout defensively and returns an untouched layout as it came', () => {
    expect(
      layoutBureauPairs({
        bubbles: [null, { assoId: A1 }, { assoId: 'a2', selectedBureau: ['u', 3] }],
      })
    ).toEqual([{ assoId: 'a2', userId: 'u' }]);
    const layout = { bubbles: [{ assoId: A1, selectedBureau: ['u1'] }] };
    const out = keepCurrentBureaus(layout, () => true);
    expect(out).toEqual({ layout, dropped: 0 });
    expect(out.layout).toBe(layout);
  });
});
