/**
 * What social-service tells the media service about vault documents and released feed media.
 *
 * The media service's sweep is an allowlist of `ephemeral`, so what matters here is the CLASS each
 * caller names: a vault document must be `association` (kept for ever, and surviving its uploader's
 * account), and a released post photo must be `ephemeral` - an object with no class is one the
 * sweep never takes, so a release that sent nothing would strand it.
 */
import { of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { Repository } from 'typeorm';
import { AssociationDocumentRetentionService } from './association-document-retention.service';
import { applyMediaRetentionClass } from '../internal/media-retention-class';
import { PostMediaRetentionService } from '../posts/post-media-retention.service';
import type { AssociationDocument } from './entities/association-document.entity';
import type { Post } from '../posts/entities/post.entity';

const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** An HttpService whose `post` records every body and answers `changed`. */
function recordingHttp(changed = 1) {
  const bodies: Array<{ mediaIds: string[]; retentionClass: string }> = [];
  const http = {
    post: jest.fn((_url: string, body: { mediaIds: string[]; retentionClass: string }) => {
      bodies.push(body);
      return of({ data: { changed } });
    }),
  };
  return { http: http as unknown as HttpService, bodies };
}

/** A logger that records instead of printing. */
function silentLogger() {
  const warnings: string[] = [];
  const logger = new Logger('spec');
  jest.spyOn(logger, 'log').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation((msg: unknown) => {
    warnings.push(String(msg));
  });
  return { logger, warnings };
}

describe('AssociationDocumentRetentionService', () => {
  function makeService(mediaIds: Array<string | null>) {
    const { http, bodies } = recordingHttp(mediaIds.length);
    const qb = {
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(() => Promise.resolve(mediaIds.map((mediaId) => ({ mediaId })))),
    };
    const repo = { createQueryBuilder: jest.fn(() => qb) };
    const service = new AssociationDocumentRetentionService(
      http,
      repo as unknown as Repository<AssociationDocument>
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    return { service, bodies };
  }

  afterEach(() => jest.restoreAllMocks());

  it('classifies every vault document as `association` at boot', async () => {
    const { service, bodies } = makeService([DOC_A, DOC_B, null]);

    await service.onModuleInit();

    expect(bodies).toEqual([{ mediaIds: [DOC_A, DOC_B], retentionClass: 'association' }]);
  });

  it('asks nothing of the media service when there is no document', async () => {
    const { service, bodies } = makeService([]);

    await service.onModuleInit();

    expect(bodies).toEqual([]);
  });
});

describe('PostMediaRetentionService.release', () => {
  it('names `ephemeral`, because an unclassified object is one the sweep never takes', async () => {
    const { http, bodies } = recordingHttp();
    const service = new PostMediaRetentionService(http, {} as Repository<Post>);

    await service.release([DOC_A]);

    expect(bodies).toEqual([{ mediaIds: [DOC_A], retentionClass: 'ephemeral' }]);
  });
});

describe('applyMediaRetentionClass', () => {
  afterEach(() => jest.restoreAllMocks());

  it('collapses duplicates and batches at the media service bound', async () => {
    const { http, bodies } = recordingHttp(2);
    const { logger } = silentLogger();
    const ids = Array.from(
      { length: 501 },
      (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    );

    const changed = await applyMediaRetentionClass(http, logger, [...ids, ids[0]], 'association');

    expect(bodies.map((b) => b.mediaIds.length)).toEqual([500, 1]);
    expect(changed).toBe(4);
  });

  it('answers null and LOGS when the media service refuses, never throws', async () => {
    const http = {
      post: jest.fn(() => throwError(() => new Error('connect ECONNREFUSED'))),
    } as unknown as HttpService;
    const { logger, warnings } = silentLogger();

    await expect(applyMediaRetentionClass(http, logger, [DOC_A], 'association')).resolves.toBe(
      null
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'association'");
  });
});
