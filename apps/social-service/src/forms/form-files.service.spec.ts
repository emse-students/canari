import {
  BadRequestException,
  GoneException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  FORM_FILE_MAX_BYTES,
  FORM_FILE_MAX_PENDING,
  FormFilesService,
  cleanFileName,
  detectFormFileType,
  fileAnswersOf,
} from './form-files.service';

/**
 * THE FILE QUESTION'S SERVER SIDE: every refusal of an upload, the ownership rule at submit, and the
 * manager's download.
 *
 * A file answer is plaintext a manager reads, so each refusal here is a way a file could reach the
 * wrong reader or the store could fill: a type that is not what it claims, a file too big, a form
 * that cannot hold one, an answer citing somebody else's upload.
 */

const PDF = Buffer.from('%PDF-1.7\n...');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const FILE_ID = '11111111-1111-4111-8111-111111111111';

const FORM = {
  id: 'f1',
  isPublic: false,
  opensAt: null,
  closedAt: null,
  deletedAt: null,
  items: [
    { id: 'q_cv', label: 'CV', type: 'file', required: true },
    { id: 'q_name', label: 'Nom', type: 'short_text', required: true },
  ],
};

function makeService(
  opts: {
    form?: Record<string, unknown> | null;
    pending?: number;
    row?: Record<string, unknown> | null;
    mediaGet?: () => unknown;
  } = {}
) {
  const fileRepo: any = {
    query: jest.fn(() => Promise.resolve([{ pending: opts.pending ?? 0 }])),
    insert: jest.fn(() => Promise.resolve()),
    findOne: jest.fn(() => Promise.resolve(opts.row === undefined ? null : opts.row)),
    update: jest.fn(() => Promise.resolve()),
  };
  const formRepo: any = {
    findOne: jest.fn(() => Promise.resolve(opts.form === undefined ? FORM : opts.form)),
  };
  const http: any = {
    post: jest.fn(() => of({ data: { mediaId: FILE_ID } })),
    get: jest.fn(opts.mediaGet ?? (() => of({ data: Buffer.from('%PDF-1.7') }))),
  };
  const service = new FormFilesService(fileRepo, formRepo, http);
  return { service, fileRepo, formRepo, http };
}

const upload = (buffer: Buffer, name = 'cv.pdf') => ({
  buffer,
  size: buffer.length,
  originalname: name,
});

describe('detectFormFileType - the type is read from the bytes', () => {
  it.each([
    ['a PDF', PDF, 'application/pdf'],
    ['a PNG', PNG, 'image/png'],
    ['a JPEG', JPEG, 'image/jpeg'],
    ['a WebP', WEBP, 'image/webp'],
    ['an HTML page', HTML, null],
    ['an empty buffer', Buffer.alloc(0), null],
  ])('%s', (_what, bytes, expected) => {
    expect(detectFormFileType(bytes)).toBe(expected);
  });
});

describe('cleanFileName', () => {
  it('keeps the device name, drops the path and quotes, and takes the REAL extension', () => {
    expect(cleanFileName('C:\\Users\\x\\mon "cv".png', 'application/pdf', FILE_ID)).toBe(
      'mon cv.pdf'
    );
  });

  it('re-reads a UTF-8 name Multer handed over as latin1', () => {
    const latin1 = Buffer.from('Résumé.pdf', 'utf8').toString('latin1');
    expect(cleanFileName(latin1, 'application/pdf', FILE_ID)).toBe('Résumé.pdf');
  });

  it('names an empty name after the id, never with a word', () => {
    expect(cleanFileName('', 'image/png', FILE_ID)).toBe('11111111.png');
  });
});

describe('FormFilesService.upload - every refusal', () => {
  it('stores an allowed file and records it for the question', async () => {
    const { service, fileRepo, http } = makeService();
    const res = await service.upload('f1', 'q_cv', upload(PDF), 'u1');
    expect(res).toEqual({
      fileId: FILE_ID,
      fileName: 'cv.pdf',
      sizeBytes: PDF.length,
      contentType: 'application/pdf',
    });
    expect(http.post.mock.calls[0][0]).toContain('media/internal/form-file');
    expect(fileRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: FILE_ID, formId: 'f1', itemId: 'q_cv', uploaderId: 'u1' })
    );
  });

  it('refuses a type that is not PDF, JPEG, PNG or WebP - whatever the name says', async () => {
    const { service, http } = makeService();
    await expect(service.upload('f1', 'q_cv', upload(HTML, 'cv.pdf'), 'u1')).rejects.toThrow(
      BadRequestException
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it('refuses a file over the cap', async () => {
    const { service, http } = makeService();
    const big = Buffer.concat([PDF, Buffer.alloc(FORM_FILE_MAX_BYTES)]);
    await expect(service.upload('f1', 'q_cv', upload(big), 'u1')).rejects.toThrow(
      PayloadTooLargeException
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it('refuses an empty file', async () => {
    const { service } = makeService();
    await expect(service.upload('f1', 'q_cv', upload(Buffer.alloc(0)), 'u1')).rejects.toThrow(
      BadRequestException
    );
  });

  it('refuses a question that is not a file question, and an unknown one', async () => {
    const { service } = makeService();
    await expect(service.upload('f1', 'q_name', upload(PDF), 'u1')).rejects.toThrow(
      BadRequestException
    );
    await expect(service.upload('f1', 'nope', upload(PDF), 'u1')).rejects.toThrow(
      BadRequestException
    );
  });

  it('refuses a public form (D40)', async () => {
    const { service } = makeService({ form: { ...FORM, isPublic: true } });
    await expect(service.upload('f1', 'q_cv', upload(PDF), 'u1')).rejects.toThrow(
      'A public form cannot receive a file.'
    );
  });

  it('refuses a form that is gone, not open, or closed', async () => {
    await expect(
      makeService({ form: null }).service.upload('f1', 'q_cv', upload(PDF), 'u1')
    ).rejects.toThrow(NotFoundException);
    const tomorrow = new Date(Date.now() + 86_400_000);
    const yesterday = new Date(Date.now() - 86_400_000);
    await expect(
      makeService({ form: { ...FORM, opensAt: tomorrow } }).service.upload(
        'f1',
        'q_cv',
        upload(PDF),
        'u1'
      )
    ).rejects.toThrow('not open yet');
    await expect(
      makeService({ form: { ...FORM, closedAt: yesterday } }).service.upload(
        'f1',
        'q_cv',
        upload(PDF),
        'u1'
      )
    ).rejects.toThrow('closed');
  });

  it('refuses a member already holding the maximum of unsent uploads on the form', async () => {
    const { service, http } = makeService({ pending: FORM_FILE_MAX_PENDING });
    await expect(service.upload('f1', 'q_cv', upload(PDF), 'u1')).rejects.toThrow(HttpException);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('takes the blob back when its row cannot be written, so nothing is stranded', async () => {
    const { service, fileRepo, http } = makeService();
    fileRepo.insert.mockRejectedValueOnce(new Error('db down'));
    http.post
      .mockReturnValueOnce(of({ data: { mediaId: FILE_ID } }))
      .mockReturnValueOnce(of({ data: { results: { [FILE_ID]: 'deleted' } } }));
    await expect(service.upload('f1', 'q_cv', upload(PDF), 'u1')).rejects.toThrow('db down');
    expect(http.post.mock.calls[1][0]).toContain('media/internal/form-file-purge');
    expect(http.post.mock.calls[1][1]).toEqual({ items: [{ mediaId: FILE_ID, ownerId: 'u1' }] });
  });
});

describe('fileAnswersOf - the shape of a file answer', () => {
  const items = FORM.items;

  it('collects one file per file question that has a value', () => {
    expect(fileAnswersOf(items, { q_cv: FILE_ID, q_name: 'Ada' })).toEqual([
      { itemId: 'q_cv', fileId: FILE_ID },
    ]);
    expect(fileAnswersOf(items, { q_name: 'Ada' })).toEqual([]);
  });

  it('refuses a value that is not a file id', () => {
    expect(() => fileAnswersOf(items, { q_cv: 'my cv' })).toThrow(BadRequestException);
    expect(() => fileAnswersOf(items, { q_cv: [FILE_ID] })).toThrow(BadRequestException);
  });
});

describe('FormFilesService.attach - the file must be the submitter own, for this question', () => {
  const sub = { id: 's1', createdAt: new Date('2026-10-15T10:00:00Z') };

  it('claims the file for the submission in one statement naming every ownership fact', async () => {
    const { service } = makeService();
    const manager: any = { query: jest.fn(() => Promise.resolve([{ id: FILE_ID }])) };
    await service.attach(manager, sub, 'f1', 'u1', [{ itemId: 'q_cv', fileId: FILE_ID }]);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain('"uploaderId" = $6');
    expect(sql).toContain('"formId" = $4');
    expect(sql).toContain('"itemId" = $5');
    expect(sql).toContain('"purgedAt" IS NULL');
    expect(params.slice(0, 6)).toEqual(['s1', sub.createdAt, FILE_ID, 'f1', 'q_cv', 'u1']);
  });

  // Somebody else's file, a file for another form or question, an expired upload: the statement
  // matches no row, and the answer is refused - rolling the whole submission back with it.
  it('refuses a file the statement does not match', async () => {
    const { service } = makeService();
    const manager: any = { query: jest.fn(() => Promise.resolve([])) };
    await expect(
      service.attach(manager, sub, 'f1', 'u2', [{ itemId: 'q_cv', fileId: FILE_ID }])
    ).rejects.toThrow(BadRequestException);
  });
});

describe('FormFilesService.answerFiles - what the manager screen is told', () => {
  it('maps each cited file to its name and whether it is purged', async () => {
    const { service, fileRepo } = makeService();
    fileRepo.query.mockResolvedValueOnce([
      { id: FILE_ID, fileName: 'cv.pdf', purged: false },
      { id: 'gone', fileName: 'old.pdf', purged: true },
    ]);
    const files = await service.answerFiles(['s1']);
    expect(files.get(FILE_ID)).toEqual({ fileName: 'cv.pdf', purged: false });
    expect(files.get('gone')).toEqual({ fileName: 'old.pdf', purged: true });
  });

  it('reads deletedFileIds from the same rows', async () => {
    const { service, fileRepo } = makeService();
    fileRepo.query.mockResolvedValueOnce([
      { id: FILE_ID, fileName: 'cv.pdf', purged: false },
      { id: 'gone', fileName: 'old.pdf', purged: true },
    ]);
    expect([...(await service.deletedFileIds(['s1']))]).toEqual(['gone']);
  });

  it('asks nothing for no submission', async () => {
    const { service, fileRepo } = makeService();
    expect((await service.answerFiles([])).size).toBe(0);
    expect(fileRepo.query).not.toHaveBeenCalled();
  });
});

describe('FormFilesService.download', () => {
  const ROW = {
    id: FILE_ID,
    formId: 'f1',
    submissionId: 's1',
    purgedAt: null,
    contentType: 'application/pdf',
    fileName: 'cv.pdf',
  };

  it('serves a sent file with its own type and name, through the internal route', async () => {
    const { service, http } = makeService({ row: ROW });
    const res = await service.download('f1', FILE_ID);
    expect(res.contentType).toBe('application/pdf');
    expect(res.fileName).toBe('cv.pdf');
    expect(http.get.mock.calls[0][0]).toContain(`media/internal/form-file/${FILE_ID}`);
  });

  it('is a 404 for a file of another form or an upload nobody sent', async () => {
    await expect(makeService({ row: null }).service.download('f1', FILE_ID)).rejects.toThrow(
      NotFoundException
    );
    await expect(
      makeService({ row: { ...ROW, submissionId: null } }).service.download('f1', FILE_ID)
    ).rejects.toThrow(NotFoundException);
  });

  it('is a 410 for a purged file', async () => {
    await expect(
      makeService({ row: { ...ROW, purgedAt: new Date() } }).service.download('f1', FILE_ID)
    ).rejects.toThrow(GoneException);
  });

  it('marks the row purged when the media service says the blob is gone', async () => {
    const { service, fileRepo } = makeService({
      row: ROW,
      mediaGet: () => throwError(() => ({ response: { status: 410 } })),
    });
    await expect(service.download('f1', FILE_ID)).rejects.toThrow(GoneException);
    expect(fileRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: FILE_ID }),
      expect.objectContaining({ purgedAt: expect.any(Date) })
    );
  });
});
