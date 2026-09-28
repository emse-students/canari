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

  /** A repository stub recording what publish/unpublish write, which is what these tests read. */
  function repo() {
    const row = { id: 'p1' } as PosterProject;
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
        transaction: (run: (m: unknown) => Promise<unknown>) =>
          run({ getRepository: () => inner }) as Promise<PosterProject>,
      },
    };
  }

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

  beforeEach(() => {
    updates = [];
    saved = undefined as unknown as PosterProject;
    service = new PosterService(repo() as never);
  });

  const patchFor = (id: string) => updates.find((u) => u.where === id)?.patch;

  it('stores the fingerprint the client computed for the document it sent', async () => {
    await service.publish('p1', { carte: carte(), fingerprint: FP });
    expect(patchFor('p1')?.publicationFingerprint).toBe(FP);
  });

  it('clears the previous live map fingerprint with its publication', async () => {
    await service.publish('p1', { carte: carte(), fingerprint: FP });
    const clearing = updates.find((u) => u.where !== 'p1');
    expect(clearing?.patch).toMatchObject({ publication: null, publicationFingerprint: null });
  });

  // The app EMBEDS its frontend, so an admin on an older build still posts the bare document.
  // Refusing it would break publishing for them; it publishes with no fingerprint instead.
  it('still publishes a bare document from a client that has no fingerprint', async () => {
    await service.publish('p1', carte());
    expect(patchFor('p1')?.publication).toBeDefined();
    expect(patchFor('p1')?.publicationFingerprint).toBeNull();
  });

  // A stored junk value would later be COMPARED, and would answer the staleness question wrongly.
  it.each([['not-hex'], ['A'.repeat(64)], ['a'.repeat(63)], [''], [42]])(
    'drops a malformed fingerprint (%p) rather than storing it',
    async (fingerprint) => {
      await service.publish('p1', { carte: carte(), fingerprint });
      expect(patchFor('p1')?.publicationFingerprint).toBeNull();
    }
  );

  it('forgets the fingerprint when the poster goes offline', async () => {
    await service.unpublish('p1');
    expect(saved.publicationFingerprint).toBeNull();
    expect(saved.publication).toBeNull();
  });
});
