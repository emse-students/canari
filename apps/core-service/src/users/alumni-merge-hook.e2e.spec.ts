import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AlumniMergeHookController,
  ALUMNI_MERGE_HOOK_SECRET_HEADER,
} from './alumni-merge-hook.controller';
import { AlumniMergeService } from './alumni-merge.service';

/**
 * THE PUSH'S ROUTE, END TO END (D54): through the edge, which routes the one path to core-service with
 * every trust header stripped, and through Nest's real HTTP stack, where the secret is checked before
 * the body is read. Named `*.e2e.spec.ts` so the ordinary jest config runs it (it needs no database:
 * the service behind the route is a stub).
 */
describe('POST /api/hooks/miconnect/alumni-merge', () => {
  const SECRET = 'a-test-secret-of-some-length-0123456789';
  const BODY = {
    duplicateUuid: '11111111-1111-4111-8111-111111111111',
    targetUuid: '22222222-2222-4222-8222-222222222222',
    mergeId: '',
  };
  const saved = process.env.MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET;
  let app: INestApplication;
  let base: string;
  const completeFromPush = jest.fn(async () => ({ completed: true }));

  beforeAll(async () => {
    process.env.MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET = SECRET;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const module = await Test.createTestingModule({
      controllers: [AlumniMergeHookController],
      providers: [{ provide: AlumniMergeService, useValue: { completeFromPush } }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/hooks/miconnect/alumni-merge`.replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
    process.env.MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET = saved;
    jest.restoreAllMocks();
  });
  beforeEach(() => completeFromPush.mockClear());

  const post = (headers: Record<string, string>, body: unknown = BODY) =>
    fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('with the secret: the service completes from the push', async () => {
    const res = await post({ [ALUMNI_MERGE_HOOK_SECRET_HEADER]: SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ completed: true });
    expect(completeFromPush).toHaveBeenCalledWith(BODY.duplicateUuid, BODY.targetUuid, '');
  });

  it('without the secret: 401, nothing read', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(completeFromPush).not.toHaveBeenCalled();
  });

  it('with a wrong secret: 401, nothing read', async () => {
    const res = await post({ [ALUMNI_MERGE_HOOK_SECRET_HEADER]: `${SECRET.slice(0, -1)}x` });
    expect(res.status).toBe(401);
    expect(completeFromPush).not.toHaveBeenCalled();
  });

  it('with the secret but a malformed body: 400, nothing read', async () => {
    const res = await post({ [ALUMNI_MERGE_HOOK_SECRET_HEADER]: SECRET }, { duplicateUuid: 'x' });
    expect(res.status).toBe(400);
    expect(completeFromPush).not.toHaveBeenCalled();
  });

  it('on an estate with no secret: 401 for everyone, the right secret included', async () => {
    process.env.MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET = '';
    try {
      const res = await post({ [ALUMNI_MERGE_HOOK_SECRET_HEADER]: '' });
      expect(res.status).toBe(401);
      expect(completeFromPush).not.toHaveBeenCalled();
    } finally {
      process.env.MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET = SECRET;
    }
  });

  it('the edge routes the path to core-service with no session and every trust header stripped', () => {
    const nginx = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'infrastructure', 'local', 'Dockerfile.frontend'),
      'utf8'
    );
    const start = nginx.indexOf('location = /api/hooks/miconnect/alumni-merge {');
    expect(start).toBeGreaterThan(-1);
    const block = nginx.slice(start, nginx.indexOf('    }', start));
    expect(block).toContain('proxy_pass http://$target_core_service;');
    expect(block).not.toContain('auth_request');
    for (const header of ['X-User-Id', 'X-Global-Admin', 'X-Internal-Token', 'X-Internal-Secret']) {
      expect(block).toMatch(new RegExp(`proxy_set_header ${header} "(false)?";`));
    }
  });
});
