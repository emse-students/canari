import { AssociationsService } from './associations.service';

/**
 * `listReviewerDocuments` feeds the whole `/documents` page, and it withholds a document by
 * skipping it - so its failure mode is an EMPTY PAGE, not an error. It shipped on 2026-07-16
 * reading the marker syntax of the day; the client moved to parentheses eight days later and
 * this listing served `[]` until 2026-09-10, with all 3 of production's public documents
 * falling through the same branch.
 *
 * `vault-markers.util.spec.ts` pins the parser against what the client writes. This file pins
 * the seam above it: that a document written by the CURRENT client comes back listed, which no
 * amount of parser testing would have caught if the service had stopped calling it.
 */

/** What `buildVaultMarkers` in `frontend/src/lib/associations/vaultCrypto.ts` emits today. */
const SALT = 'a8f1c0de-1234-4bcd-89ef-0123456789ab';
const VAULT_KEY = 'f'.repeat(64);

interface DocRow {
  id: string;
  associationId: string;
  name: string;
  description: string | null;
  visibility: 'private' | 'public';
  mediaId: string;
  mimeType: string;
  size: number;
  originalFilename: string | null;
  createdAt: Date;
}

function doc(over: Partial<DocRow> = {}): DocRow {
  return {
    id: 'doc-1',
    associationId: 'asso-1',
    name: 'Statuts de l association',
    description: `(s:${SALT})`,
    visibility: 'public',
    mediaId: 'media-1',
    mimeType: 'application/pdf',
    size: 1024,
    originalFilename: 'statuts.pdf',
    createdAt: new Date('2026-08-22T10:00:00Z'),
    ...over,
  };
}

function makeService(docs: DocRow[], vaultKey: string | null = VAULT_KEY) {
  const docRepo = {
    // The listing asks for `visibility: 'public'`; the seeded rows are filtered the same way so
    // a test row marked private cannot leak into the result by accident.
    find: jest.fn(({ where }: { where: { visibility: string } }) =>
      Promise.resolve(docs.filter((d) => d.visibility === where.visibility))
    ),
  };
  const assoRepo = {
    find: jest.fn(() =>
      Promise.resolve([
        {
          id: 'asso-1',
          name: 'Les Rootz',
          slug: 'les-rootz',
          logoUrl: null,
          documentVaultKey: vaultKey,
        },
      ])
    ),
  };
  const warn = jest.fn();

  // POSITIONAL, AND THIRTEEN LONG - so a constructor change silently shifts every argument after
  // the one it touched. The comments are the guard: keep them aligned with the parameter list in
  // `associations.service.ts`, and change them in the same commit that changes it.
  const service = new AssociationsService(
    assoRepo as never, // assoRepo
    undefined as never, // memberRepo
    undefined as never, // calendarRepo
    undefined as never, // coOwnerRepo
    docRepo as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never // userTagService
  );
  // The logger is private and the accusing warning is half of the fix, so it is asserted rather
  // than left to the console.
  (service as unknown as { logger: { warn: unknown } }).logger = { warn };
  return { service, warn };
}

describe('AssociationsService.listReviewerDocuments', () => {
  it('lists a public document written by the current client', async () => {
    // THE REGRESSION. A parenthesis marker is what every production row carries.
    const { service } = makeService([doc()]);

    const groups = await service.listReviewerDocuments();

    expect(groups).toHaveLength(1);
    expect(groups[0].associationName).toBe('Les Rootz');
    expect(groups[0].documents.map((d) => d.name)).toEqual(['Statuts de l association']);
  });

  it('lists a public document written before the format changed', async () => {
    const { service } = makeService([doc({ description: `[s:${SALT}]` })]);

    const groups = await service.listReviewerDocuments();

    expect(groups[0].documents).toHaveLength(1);
  });

  it('derives the same key for both marker syntaxes, since the salt is the same', async () => {
    // The marker is packaging; the salt inside it is what the key depends on. A reader that
    // treated the two syntaxes as different salts would hand out an undecryptable key.
    const { service: current } = makeService([doc()]);
    const { service: legacy } = makeService([doc({ description: `[s:${SALT}]` })]);

    const [a] = await current.listReviewerDocuments();
    const [b] = await legacy.listReviewerDocuments();

    expect(a.documents[0].cek).toBe(b.documents[0].cek);
    expect(a.documents[0].cek).toHaveLength(64); // 32 bytes, hex
  });

  it('withholds a document whose description carries no marker, and says so', async () => {
    const { service, warn } = makeService([doc({ description: 'Statuts' })]);

    await expect(service.listReviewerDocuments()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no CEK salt marker'));
  });

  it('withholds a password-protected document, and says so', async () => {
    // Its CEK folds in a password the server never sees, so a derived key could not open it.
    const { service, warn } = makeService([
      doc({ description: `(s:${SALT})(pw:${'0'.repeat(32)})` }),
    ]);

    await expect(service.listReviewerDocuments()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('password-protected'));
  });

  it('withholds every document of an association with no vault key, and says so', async () => {
    const { service, warn } = makeService([doc()], null);

    await expect(service.listReviewerDocuments()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no vault key'));
  });

  it('never reads a private document', async () => {
    const { service } = makeService([doc({ id: 'doc-2', visibility: 'private' })]);

    await expect(service.listReviewerDocuments()).resolves.toEqual([]);
  });
});
