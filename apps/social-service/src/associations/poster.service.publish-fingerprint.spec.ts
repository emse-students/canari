import { BadRequestException } from '@nestjs/common';
import { PosterService } from './poster.service';
import { PosterProject } from './entities/poster-project.entity';

/**
 * What the publish path records about WHICH document went live.
 *
 * The fingerprint is the only durable answer to "is the live map older than what is saved":
 * `publishedAt` cannot answer it, because publishing writes the row and `updatedAt` moves with it in
 * the same statement.
 */
describe('PosterService - the fingerprint of the document that went live', () => {
  const FP = 'a'.repeat(64);
  let updates: { where: unknown; patch: Record<string, unknown> }[];
  let saved: PosterProject;
  let service: PosterService;

  /** The platform admin: bounded by nothing, so no scope query runs. */
  const ADMIN = { userId: 'admin', isGlobalAdmin: true };
  /** The switches the map holds; `a1` is on unless a test turns it off. */
  let entries: { associationId: string; enabled: boolean }[];

  /** A repository stub recording what publish/unpublish write, which is what these tests read. */
  function repo() {
    const row = { id: 'p1', spaceId: 's1' } as PosterProject;
    const inner = {
      update: (where: unknown, patch: Record<string, unknown>) => {
        updates.push({ where, patch });
        return Promise.resolve({ affected: 1 });
      },
      findOne: () => Promise.resolve(row),
    };
    return {
      findOne: () => Promise.resolve(row),
      save: (project: PosterProject) => {
        saved = project;
        return Promise.resolve(project);
      },
      manager: {
        // The associations space `s1` offers (`CARTE_SPACE_ASSOCIATIONS_SQL`).
        query: () => Promise.resolve([{ id: 'a1' }]),
        transaction: (run: (m: unknown) => Promise<unknown>) =>
          run({
            getRepository: () => inner,
            // The per-space lock (`SELECT ... FOR UPDATE`): recorded, answered with nothing.
            query: (sql: string, params: unknown[]) => {
              locks.push({ sql, params });
              return Promise.resolve([]);
            },
          }) as Promise<PosterProject>,
      },
    };
  }

  /** The switch table stub: `find` answers the switches that are ON, as the service asks. */
  const entryRepo = () => ({
    find: () => Promise.resolve(entries.filter((e) => e.enabled)),
  });

  /** The smallest document `sanitizePublishedCarte` accepts: one placeable unit. */
  function carte() {
    return {
      aspectRatio: Math.SQRT2,
      stage: { w: 1600, h: 1131 },
      background: { dataUrl: null, scrimOpacity: 20 },
      style: {
        pageBg: '#fdf3e3',
        scrimColor: '#3a2a12',
        cardBg: '#ffffff',
        cardTextColor: '#374151',
        directoryBg: '#ffffff',
        directoryTextColor: '#1f2937',
        directoryMutedColor: '#6b7280',
      },
      title: {
        x: 48,
        y: 36,
        w: 1004,
        z: 0,
        size: 52,
        weight: 700,
        content: 'Carte 2026',
        align: 'left',
        color: '#7c2d12',
      },
      units: [
        {
          assoId: 'a1',
          x: 120,
          y: 90,
          w: 400,
          h: 430,
          scale: 0.5,
          z: 1,
          color: null,
          colorFallback: '#7c2d12',
          blob: { x: 95, y: 67, size: 210, radius: '50%' },
          logo: { x: 154, y: 88, w: 92, h: 92, radius: '12px', initialsSize: 36, initials: 'A1' },
          name: { x: 123, y: 184, w: 154, size: 17, emailSize: 6 },
          cards: [],
        },
      ],
      texts: [],
      directory: null,
    };
  }

  let locks: { sql: string; params: unknown[] }[] = [];

  beforeEach(() => {
    locks = [];
    updates = [];
    saved = undefined as unknown as PosterProject;
    entries = [{ associationId: 'a1', enabled: true }];
    service = new PosterService(repo() as never, {} as never, entryRepo() as never);
  });

  const patchFor = (id: string) => updates.find((u) => u.where === id)?.patch;

  it('stores the fingerprint the client computed for the document it sent', async () => {
    await service.publish('p1', { carte: carte(), fingerprint: FP }, ADMIN);
    expect(patchFor('p1')?.publicationFingerprint).toBe(FP);
  });

  it('clears the previous live map OF ITS SPACE, fingerprint included', async () => {
    await service.publish('p1', { carte: carte(), fingerprint: FP }, ADMIN);
    const clearing = updates.find((u) => u.where !== 'p1');
    expect(clearing?.where).toMatchObject({ spaceId: 's1' });
    expect(clearing?.patch).toMatchObject({ publication: null, publicationFingerprint: null });
  });

  // The document is built by the editor; the server holds the rule that a switched-off association
  // never reaches the anonymous showcase through this map.
  it('refuses a unit whose association is switched off on the map, and publishes nothing', async () => {
    entries = [{ associationId: 'a1', enabled: false }];
    await expect(
      service.publish('p1', { carte: carte(), fingerprint: FP }, ADMIN)
    ).rejects.toMatchObject({ response: { code: 'CARTE_UNIT_OUTSIDE_MAP' } });
    expect(updates).toEqual([]);
  });

  it('serialises the publish on its space row before clearing the previous live map', async () => {
    await service.publish('p1', { carte: carte(), fingerprint: FP }, ADMIN);
    expect(locks).toEqual([
      { sql: expect.stringMatching(/FROM spaces .* FOR UPDATE/), params: ['s1'] },
    ]);
  });

  // A roster line is as public as a unit: a switched-off association is no more in the directory.
  it('refuses a directory line naming an association the map does not show', async () => {
    const doc = {
      ...carte(),
      directory: {
        zones: [
          {
            label: 'Z',
            assos: [
              { assoId: 'a1', line: 'x' },
              { assoId: 'a9', line: 'y' },
            ],
          },
        ],
      },
    };
    await expect(
      service.publish('p1', { carte: doc, fingerprint: FP }, ADMIN)
    ).rejects.toMatchObject({
      response: { code: 'CARTE_UNIT_OUTSIDE_MAP' },
    });
    expect(updates).toEqual([]);
  });

  // Every client admitted since floor 1.2.7 sends the wrapper, so a bare document is a bug.
  it('refuses a bare document, and publishes nothing', async () => {
    await expect(service.publish('p1', carte(), ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    expect(patchFor('p1')).toBeUndefined();
  });

  // A stored junk value would later be COMPARED, and would answer the staleness question wrongly;
  // every admitted client sends a well-formed one, so an absent or malformed one is refused.
  it.each([['not-hex'], ['A'.repeat(64)], ['a'.repeat(63)], [''], [42], [undefined]])(
    'refuses a malformed or absent fingerprint (%p), and publishes nothing',
    async (fingerprint) => {
      await expect(
        service.publish('p1', { carte: carte(), fingerprint }, ADMIN)
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(patchFor('p1')).toBeUndefined();
    }
  );

  it('forgets the fingerprint when the poster goes offline', async () => {
    await service.unpublish('p1', ADMIN);
    expect(saved.publicationFingerprint).toBeNull();
    expect(saved.publication).toBeNull();
  });
});
