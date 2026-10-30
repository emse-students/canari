import { Logger, Module, ParseUUIDPipe, type INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { SECRET_BOX_ENV } from '../common/secret-box';
import { InternalLydiaKeyController } from '../internal/internal-lydia-key.controller';
import { AssociationsController, LYDIA_KEY_PASTE_RETIRED } from './associations.controller';
import { AssociationsService, LYDIA_ACCOUNT_ALREADY_LINKED } from './associations.service';
import type { ProductsService } from './products.service';
import type { PartnershipsService } from './partnerships.service';
import type { FollowsService } from '../follows/follows.service';
import type { UserTagService } from '../users/user-tag.service';
import type { UserProfileService } from './user-profile.service';

/**
 * THE LYDIA BUSINESS KEY IS WRITE-ONLY, ENCRYPTED AT REST, AND LEAVES DECRYPTED TO CORE ALONE.
 * Every key below is a throwaway string made up for the test; none was ever issued by Lydia.
 */
const ASSO_A = '0b7e1c52-6a0e-4a43-9a43-111111111111';
const ASSO_B = '0b7e1c52-6a0e-4a43-9a43-222222222222';
const KEY_A = 'throwaway-business-key-of-a';
const SECRET = 'throwaway-encryption-secret-0123456789abcdef';
const INTERNAL = 'throwaway-internal-secret';

type Row = {
  id: string;
  lydiaAccountId: string | null;
  sealed: string | null;
  dashboardUrl?: string | null;
  complete?: boolean;
};

/** The association table as the raw SQL of `setLydiaAccountId` & co. reads and writes it. */
function makeService(rows: Row[]) {
  const table = rows.map((r) => ({ ...r }));
  const byId = (id: string) => table.find((r) => r.id === id);
  const assoRepo = {
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = byId(where.id);
      return row ? { id: row.id, lydiaAccountId: row.lydiaAccountId } : null;
    }),
    query: jest.fn(async (sql: string, params: string[]) => {
      if (sql.startsWith('UPDATE associations') && sql.includes('SET "lydiaAccountId" = $2')) {
        // The link: one statement, only onto a row with NO Business ([rows, count], as pg answers).
        const row = byId(params[0]);
        if (!row || row.lydiaAccountId !== null) return [[], 0];
        row.lydiaAccountId = params[1];
        row.dashboardUrl = params[2] ?? row.dashboardUrl ?? null;
        row.sealed = params[3];
        return [[{ id: row.id }], 1];
      }
      if (sql.startsWith('SELECT id, "lydiaOnboardingComplete" AS complete')) {
        return table
          .filter((r) => r.lydiaAccountId === params[0])
          .map((r) => ({ id: r.id, complete: r.complete === true }));
      }
      if (sql.startsWith('UPDATE associations SET "lydiaBusinessKeyCiphertext" = NULL')) {
        byId(params[0])!.sealed = null;
        return [];
      }
      if (sql.startsWith('SELECT ("lydiaBusinessKeyCiphertext" IS NOT NULL)')) {
        const row = byId(params[0]);
        return row ? [{ set: row.sealed !== null }] : [];
      }
      if (sql.startsWith('SELECT id, "lydiaBusinessKeyCiphertext" AS sealed')) {
        return table
          .filter((r) => r.lydiaAccountId === params[0] && r.sealed !== null)
          .map((r) => ({ id: r.id, sealed: r.sealed }));
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  const service = Object.assign(Object.create(AssociationsService.prototype) as object, {
    assoRepo,
    logger: new Logger('AssociationsService'),
    redis: { deleteByPattern: jest.fn(async () => 0) },
  }) as unknown as AssociationsService;
  return { service, table };
}

/** Every string any logger received during `run`, to prove the key never reached one. */
async function loggedDuring(run: () => Promise<unknown>): Promise<string> {
  const spies = (['log', 'debug', 'warn', 'error', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined)
  );
  try {
    await run().catch(() => undefined);
    return spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
}

const previousSecret = process.env[SECRET_BOX_ENV];
beforeEach(() => {
  process.env[SECRET_BOX_ENV] = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env[SECRET_BOX_ENV];
  else process.env[SECRET_BOX_ENV] = previousSecret;
});

/** Links `id` to `vendor` with `key`, the one way a key is stored since enrolment lot 1. */
const link = (service: AssociationsService, id: string, vendor: string, key: string) =>
  loggedDuring(() => service.setLydiaAccountId(id, vendor, null, key));

describe('AssociationsService - the Lydia Business key', () => {
  it('answers null alike for an unknown vendor token and a Business with no key', async () => {
    const { service } = makeService([{ id: ASSO_A, lydiaAccountId: 'vendor-a', sealed: null }]);
    await expect(service.lydiaCallbackKey('vendor-a')).resolves.toBeNull();
    await expect(service.lydiaCallbackKey('vendor-nobody')).resolves.toBeNull();
    await expect(service.lydiaCallbackKey('')).resolves.toBeNull();
  });

  it('a ciphertext copied to another association, or kept across a new Business, does not open', async () => {
    const { service, table } = makeService([
      { id: ASSO_A, lydiaAccountId: null, sealed: null },
      { id: ASSO_B, lydiaAccountId: 'vendor-b', sealed: null },
    ]);
    await link(service, ASSO_A, 'vendor-a', KEY_A);
    table[1].sealed = table[0].sealed;
    await loggedDuring(async () => expect(await service.lydiaCallbackKey('vendor-b')).toBeNull());
    // Re-onboarded: the vendor token changed, the old ciphertext stays bound to the old one.
    table[1].sealed = null;
    table[0].lydiaAccountId = 'vendor-a2';
    await loggedDuring(async () => expect(await service.lydiaCallbackKey('vendor-a2')).toBeNull());
  });

  it('THROWS a 503 when the server lost its encryption secret - a config failure, not a null verdict', async () => {
    const { service } = makeService([{ id: ASSO_A, lydiaAccountId: null, sealed: null }]);
    await link(service, ASSO_A, 'vendor-a', KEY_A);
    delete process.env[SECRET_BOX_ENV];
    const logs = await loggedDuring(async () =>
      expect(service.lydiaCallbackKey('vendor-a')).rejects.toMatchObject({ status: 503 })
    );
    expect(logs).toContain('LYDIA_KEY_ENCRYPTION_SECRET is not configured');
    expect(logs).not.toContain(KEY_A);
  });

  it('refuses rather than guesses when two associations hold a key for one vendor token', async () => {
    const { service, table } = makeService([
      { id: ASSO_A, lydiaAccountId: null, sealed: null },
      { id: ASSO_B, lydiaAccountId: null, sealed: null },
    ]);
    await link(service, ASSO_A, 'vendor-x', KEY_A);
    await link(service, ASSO_B, 'vendor-x', 'throwaway-business-key-of-b');
    expect(table.every((r) => r.sealed)).toBe(true);
    await loggedDuring(async () => expect(await service.lydiaCallbackKey('vendor-x')).toBeNull());
  });
});

describe('AssociationsService.setLydiaAccountId - the key captured at business/create', () => {
  it('links the Business and stores its key encrypted, opening for core, never logged', async () => {
    const { service, table } = makeService([{ id: ASSO_A, lydiaAccountId: null, sealed: null }]);
    const logs = await loggedDuring(() =>
      service.setLydiaAccountId(ASSO_A, 'vendor-a', 'https://lydia.example/d', KEY_A)
    );
    expect(table[0]).toMatchObject({
      lydiaAccountId: 'vendor-a',
      dashboardUrl: 'https://lydia.example/d',
    });
    expect(table[0].sealed).toMatch(/^v1\./);
    expect(table[0].sealed).not.toContain(KEY_A);
    expect(logs).toContain('[AUDIT] Lydia Business linked');
    expect(logs).not.toContain(KEY_A);
    // The column the callback lookup opens, and the status the old screens read.
    await loggedDuring(async () => expect(await service.lydiaCallbackKey('vendor-a')).toBe(KEY_A));
    await expect(service.isLydiaBusinessKeySet(ASSO_A)).resolves.toBe(true);
  });

  it('refuses a re-run with the TYPED 409 and leaves the linked Business and its key untouched', async () => {
    const { service, table } = makeService([{ id: ASSO_A, lydiaAccountId: null, sealed: null }]);
    await loggedDuring(() => service.setLydiaAccountId(ASSO_A, 'vendor-a', null, KEY_A));
    const before = { ...table[0] };
    await loggedDuring(async () =>
      expect(
        service.setLydiaAccountId(ASSO_A, 'vendor-b', null, 'throwaway-business-key-of-b')
      ).rejects.toMatchObject({ status: 409, response: { code: LYDIA_ACCOUNT_ALREADY_LINKED } })
    );
    expect(table[0]).toEqual(before);
  });

  it('answers 404, not 409, for an association that does not exist', async () => {
    const { service } = makeService([]);
    await loggedDuring(async () =>
      expect(service.setLydiaAccountId(ASSO_A, 'vendor-a', null, KEY_A)).rejects.toMatchObject({
        status: 404,
      })
    );
  });

  it('refuses before writing: no key, a malformed key, no vendor token, no secret', async () => {
    const { service, table } = makeService([{ id: ASSO_A, lydiaAccountId: null, sealed: null }]);
    await loggedDuring(async () => {
      for (const [vendor, key] of [
        ['vendor-a', undefined],
        ['vendor-a', 'short'],
        ['vendor-a', 'has a space in it'],
        ['', KEY_A],
        [42, KEY_A],
      ] as Array<[unknown, unknown]>) {
        await expect(service.setLydiaAccountId(ASSO_A, vendor, null, key)).rejects.toMatchObject({
          status: 400,
        });
      }
      delete process.env[SECRET_BOX_ENV];
      await expect(
        service.setLydiaAccountId(ASSO_A, 'vendor-a', null, KEY_A)
      ).rejects.toMatchObject({
        status: 503,
      });
    });
    expect(table[0]).toMatchObject({ lydiaAccountId: null, sealed: null });
  });
});

describe('AssociationsService.lydiaBusinessOfVendorToken - a read for the unsigned webhook', () => {
  it('names the holder, null for none and for two, and only ever SELECTs', async () => {
    const { service } = makeService([
      { id: ASSO_A, lydiaAccountId: 'vendor-a', sealed: null, complete: true },
      { id: ASSO_B, lydiaAccountId: 'vendor-x', sealed: null },
      { id: '0b7e1c52-6a0e-4a43-9a43-333333333333', lydiaAccountId: 'vendor-x', sealed: null },
    ]);
    const repo = (service as unknown as { assoRepo: { query: jest.Mock } }).assoRepo;
    await expect(service.lydiaBusinessOfVendorToken('vendor-a')).resolves.toEqual({
      associationId: ASSO_A,
      onboardingComplete: true,
    });
    await expect(service.lydiaBusinessOfVendorToken('vendor-nobody')).resolves.toBeNull();
    await expect(service.lydiaBusinessOfVendorToken('')).resolves.toBeNull();
    await loggedDuring(async () =>
      expect(await service.lydiaBusinessOfVendorToken('vendor-x')).toBeNull()
    );
    for (const [sql] of repo.query.mock.calls) expect(String(sql)).toMatch(/^SELECT /);
  });
});

/**
 * THE PASTE ROUTE IS A SHIM FOR OLD STORE BUILDS (legacy-compatibility.md): they still show the
 * paste field, so `PUT :id/lydia-business-key` answers a typed 410 and writes nothing. The GET
 * status route stays for those same screens.
 */
describe('AssociationsController - the retired paste route and the status route', () => {
  function makeController(allowed: boolean) {
    const service = {
      canManagePayoutAccount: jest.fn(() => Promise.resolve(allowed)),
      isLydiaBusinessKeySet: jest.fn(() => Promise.resolve(true)),
      setLydiaAccountId: jest.fn(() => Promise.resolve()),
    };
    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService,
      {} as never
    );
    return { controller, service };
  }

  it.each(['retiredLydiaBusinessKeyPaste', 'lydiaBusinessKeyStatus'] as const)(
    '%s is behind the sign-in guard and parses :id as a UUID',
    (handler) => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        AssociationsController.prototype[handler]
      ) as unknown[];
      expect(guards).toContain(NginxAuthGuard);
      const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, AssociationsController, handler) as
        | Record<string, { data?: unknown; pipes?: unknown[] }>
        | undefined;
      const id = Object.values(meta ?? {}).find((arg) => arg.data === 'id');
      expect(id?.pipes).toContain(ParseUUIDPipe);
    }
  );

  it('answers the typed 410 LYDIA_KEY_PASTE_RETIRED, writes nothing, and logs no key', async () => {
    const { controller, service } = makeController(true);
    let thrown: unknown;
    const logs = await loggedDuring(async () => {
      try {
        controller.retiredLydiaBusinessKeyPaste('treasurer', ASSO_A);
      } catch (e: unknown) {
        thrown = e;
      }
    });
    expect(thrown).toMatchObject({ status: 410, response: { code: LYDIA_KEY_PASTE_RETIRED } });
    expect(JSON.stringify((thrown as { getResponse(): unknown }).getResponse())).not.toContain(
      KEY_A
    );
    expect(logs).toContain('old client');
    expect(logs).not.toContain(KEY_A);
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it('the status route still answers a manager `{ set }` and refuses anyone else', async () => {
    const allowed = makeController(true);
    await expect(
      allowed.controller.lydiaBusinessKeyStatus('treasurer', undefined, ASSO_A)
    ).resolves.toEqual({ set: true });
    const refused = makeController(false);
    await expect(
      refused.controller.lydiaBusinessKeyStatus('member', undefined, ASSO_A)
    ).rejects.toMatchObject({ status: 403 });
    expect(refused.service.isLydiaBusinessKeySet).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/associations/lydia-callback-key - core-service only', () => {
  let app: INestApplication;
  let baseUrl: string;
  const previousInternal = process.env.INTERNAL_SECRET;

  beforeAll(async () => {
    process.env.INTERNAL_SECRET = INTERNAL;
    process.env[SECRET_BOX_ENV] = SECRET;
    const { service } = makeService([{ id: ASSO_A, lydiaAccountId: null, sealed: null }]);
    await link(service, ASSO_A, 'vendor-a', KEY_A);
    @Module({
      controllers: [InternalLydiaKeyController],
      providers: [{ provide: AssociationsService, useValue: service }],
    })
    class KeyRouteModule {}
    app = await NestFactory.create(KeyRouteModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
    process.env.INTERNAL_SECRET = previousInternal;
  });

  const ask = (vendorToken: string, secret?: string) =>
    fetch(`${baseUrl}/api/internal/associations/lydia-callback-key`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-internal-secret': secret } : {}),
      },
      body: JSON.stringify({ vendorToken }),
    });

  it('refuses a caller without the internal secret, and says nothing of the key', async () => {
    for (const secret of [undefined, 'wrong-secret']) {
      const res = await ask('vendor-a', secret);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(KEY_A);
    }
  });

  it('answers core the decrypted key, uncacheable, and null alike for unknown and keyless', async () => {
    const hit = await ask('vendor-a', INTERNAL);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('cache-control')).toBe('no-store');
    expect(await hit.json()).toEqual({ businessPrivateToken: KEY_A });
    const miss = await ask('vendor-nobody', INTERNAL);
    expect(await miss.json()).toEqual({ businessPrivateToken: null });
  });

  it('answers the holder of a vendor token - and never its key - behind the internal secret', async () => {
    const lookup = (secret?: string) =>
      fetch(`${baseUrl}/api/internal/associations/lydia-business-of-vendor-token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-internal-secret': secret } : {}),
        },
        body: JSON.stringify({ vendorToken: 'vendor-a' }),
      });
    expect((await lookup()).status).toBe(403);
    const hit = await lookup(INTERNAL);
    expect(hit.status).toBe(200);
    const text = await hit.text();
    expect(JSON.parse(text)).toEqual({ associationId: ASSO_A, onboardingComplete: false });
    expect(text).not.toContain(KEY_A);
  });
});
