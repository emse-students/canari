/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import {
  HandoffAccessClass,
  HandoffAccessRefused,
  MiconnectHandoffAccess,
  type HandoffAccessClassCode,
} from './handoff-access';
import { MiconnectReaderClient } from './miconnect-reader.client';

/**
 * F3-BOUND, against a MOCKED MiConnect (its real API is proven by
 * infrastructure/authentik/test-handoff-reader.py). Pinned: a mint passes only when the account is
 * active, the application has no enabled binding and the default-access flag is not false; every
 * other answer, and every failure to get one, is a typed refusal - never a pass. The four reads are
 * the ones the reader account may make, with its token as the Bearer.
 */
const BASE = 'https://miconnect.example';
const TOKEN = 'reader-token-under-test';
const UUID = '0b6c1c52-3d7c-4a3e-9d8a-2f1e7c9a0b11';

interface World {
  users: { pk: number; is_active: boolean; uid?: string }[];
  /** Enabled bindings on the application itself. */
  bindings: number;
  /** Enabled bindings per binding target other than the application (a flow's or a stage's pbm). */
  flowBindings?: Record<string, number>;
  /** The authorization flow's `authentication` requirement. */
  flowAuth?: string;
  /** The provider's flows; a null one is a provider that names none. */
  providerFlows?: { authentication_flow: string | null; authorization_flow: string | null };
  flags: Record<string, unknown>;
  status?: Partial<Record<'users' | 'app' | 'bindings' | 'settings' | 'flows' | 'stages', number>>;
  down?: boolean;
}

/** The flows of the fake provider, and the binding targets they expose. */
const AUTHZ = 'authz-flow-uuid';
const AUTHN = 'authn-flow-uuid';
const flowPbm = (flow: string) => `${flow}-pbm`;
const stagePbm = (flow: string) => `${flow}-stage-pbm`;

function fakeFetch(world: World) {
  const calls: { url: string; auth: string | null; method: string }[] = [];
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fn = jest.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization'), method: init?.method ?? 'GET' });
    if (world.down) return Promise.reject(new TypeError('fetch failed'));
    const path = new URL(url).pathname;
    const pick = (k: keyof NonNullable<World['status']>) => world.status?.[k];
    const query = new URL(url).searchParams;
    if (path === '/api/v3/core/users/') {
      return reply(pick('users') ?? 200, {
        results: world.users.map((u) => ({ uid: 'user-a', ...u })),
      });
    }
    if (path.startsWith('/api/v3/core/applications/')) {
      return reply(pick('app') ?? 200, {
        pk: 'app-pbm-uuid',
        slug: path.split('/')[5],
        provider_obj: world.providerFlows ?? {
          authentication_flow: AUTHN,
          authorization_flow: AUTHZ,
        },
      });
    }
    if (path === '/api/v3/flows/instances/') {
      const flow = query.get('flow_uuid') ?? '';
      const authentication =
        flow === AUTHZ ? (world.flowAuth ?? 'require_authenticated') : 'require_unauthenticated';
      return reply(pick('flows') ?? 200, {
        results: [{ pk: flow, policybindingmodel_ptr_id: flowPbm(flow), authentication }],
      });
    }
    if (path === '/api/v3/flows/bindings/') {
      const flow = query.get('target') ?? '';
      return reply(pick('stages') ?? 200, {
        pagination: { count: 1 },
        results: [{ pk: `${flow}-stage`, policybindingmodel_ptr_id: stagePbm(flow) }],
      });
    }
    if (path === '/api/v3/policies/bindings/') {
      const count = query
        .getAll('target_in')
        .reduce(
          (n, t) => n + (t === 'app-pbm-uuid' ? world.bindings : (world.flowBindings?.[t] ?? 0)),
          0
        );
      return reply(pick('bindings') ?? 200, { pagination: { count }, results: [] });
    }
    if (path === '/api/v3/admin/settings/') {
      return reply(pick('settings') ?? 200, { flags: world.flags });
    }
    return reply(404, {});
  });
  return { fn, calls };
}

const OPEN_WORLD: World = { users: [{ pk: 7, is_active: true }], bindings: 0, flags: {} };

describe('MiconnectHandoffAccess (F3-bound)', () => {
  const saved = {
    base: process.env.AUTHENTIK_BASE_URL,
    token: process.env.MICONNECT_READER_TOKEN,
  };
  let lines: string[];
  const realFetch = global.fetch;

  beforeEach(() => {
    lines = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
    }
    process.env.AUTHENTIK_BASE_URL = `${BASE}/`;
    process.env.MICONNECT_READER_TOKEN = TOKEN;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = realFetch;
    for (const [k, v] of [
      ['AUTHENTIK_BASE_URL', saved.base],
      ['MICONNECT_READER_TOKEN', saved.token],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const build = (world: World, miconnectUuid: string | null = UUID) => {
    const fake = fakeFetch(world);
    global.fetch = fake.fn as unknown as typeof fetch;
    const users = { findOne: jest.fn(async () => ({ id: 'user-a', miconnectUuid })) };
    const access = new MiconnectHandoffAccess(users as never, new MiconnectReaderClient());
    return { access, calls: fake.calls, users };
  };

  const refusal = async (p: Promise<void>): Promise<HandoffAccessRefused> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof HandoffAccessRefused) return e;
      throw e;
    }
    throw new Error('expected a refusal, the mint was let through');
  };

  it('lets an active account into an unbound application, with the reads and the reader token', async () => {
    const { access, calls } = build(OPEN_WORLD);
    await expect(access.assertMayEnter('user-a', 'migallery')).resolves.toBeUndefined();
    expect(calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
      '/api/v3/admin/settings/',
      '/api/v3/core/applications/migallery/',
      '/api/v3/core/users/',
      '/api/v3/flows/bindings/',
      '/api/v3/flows/bindings/',
      '/api/v3/flows/instances/',
      '/api/v3/flows/instances/',
      '/api/v3/policies/bindings/',
      '/api/v3/policies/bindings/',
      '/api/v3/policies/bindings/',
    ]);
    for (const c of calls) {
      expect(c.method).toBe('GET');
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
    }
    const users = new URL(calls.find((c) => c.url.includes('/core/users/'))!.url);
    expect(users.searchParams.get('uuid')).toBe(UUID);
    const targets = calls
      .filter((c) => c.url.includes('/policies/bindings/'))
      .map((c) => new URL(c.url).searchParams);
    for (const q of targets) expect(q.get('enabled')).toBe('true');
    // Every binding target an OIDC sign-in walks through is counted: the application, both flows
    // and their stage bindings.
    expect(targets.flatMap((q) => q.getAll('target_in')).sort()).toEqual(
      ['app-pbm-uuid', flowPbm(AUTHN), flowPbm(AUTHZ), stagePbm(AUTHN), stagePbm(AUTHZ)].sort()
    );
  });

  it('lets the flag set explicitly true through as well', async () => {
    const { access } = build({ ...OPEN_WORLD, flags: { core_default_app_access: true } });
    await expect(access.assertMayEnter('user-a', 'sky')).resolves.toBeUndefined();
  });

  it.each<[string, World, string | null, HandoffAccessClassCode]>([
    ['an account with no MiConnect uuid', OPEN_WORLD, null, HandoffAccessClass.notLinked],
    [
      'a uuid MiConnect does not know',
      { ...OPEN_WORLD, users: [] },
      UUID,
      HandoffAccessClass.unknownAccount,
    ],
    [
      'a deactivated account',
      { ...OPEN_WORLD, users: [{ pk: 7, is_active: false }] },
      UUID,
      HandoffAccessClass.inactive,
    ],
    [
      'a uuid whose MiConnect user is another person',
      { ...OPEN_WORLD, users: [{ pk: 7, is_active: true, uid: 'someone-else' }] },
      UUID,
      HandoffAccessClass.identityMismatch,
    ],
    [
      'a user answer that carries no uid',
      { ...OPEN_WORLD, users: [{ pk: 7, is_active: true, uid: '' }] },
      UUID,
      HandoffAccessClass.refused,
    ],
    [
      'an application with a binding',
      { ...OPEN_WORLD, bindings: 1 },
      UUID,
      HandoffAccessClass.policyBound,
    ],
    [
      'a policy bound on the authorization flow',
      { ...OPEN_WORLD, flowBindings: { [flowPbm(AUTHZ)]: 1 } },
      UUID,
      HandoffAccessClass.policyBound,
    ],
    [
      'a policy bound on a stage of the authentication flow',
      { ...OPEN_WORLD, flowBindings: { [stagePbm(AUTHN)]: 2 } },
      UUID,
      HandoffAccessClass.policyBound,
    ],
    [
      'an authorization flow that requires a superuser',
      { ...OPEN_WORLD, flowAuth: 'require_superuser' },
      UUID,
      HandoffAccessClass.flowRestricted,
    ],
    [
      'a provider that names no authentication flow (the brand default is not read)',
      { ...OPEN_WORLD, providerFlows: { authentication_flow: null, authorization_flow: AUTHZ } },
      UUID,
      HandoffAccessClass.refused,
    ],
    [
      'the reader losing view_flow (403)',
      { ...OPEN_WORLD, status: { flows: 403 } },
      UUID,
      HandoffAccessClass.refused,
    ],
    [
      'default access switched off',
      { ...OPEN_WORLD, flags: { core_default_app_access: false } },
      UUID,
      HandoffAccessClass.defaultAccessOff,
    ],
    ['MiConnect unreachable', { ...OPEN_WORLD, down: true }, UUID, HandoffAccessClass.unreachable],
    [
      'the reader losing view_application (403)',
      { ...OPEN_WORLD, status: { app: 403 } },
      UUID,
      HandoffAccessClass.refused,
    ],
    [
      'the bindings read refused',
      { ...OPEN_WORLD, status: { bindings: 403 } },
      UUID,
      HandoffAccessClass.refused,
    ],
    [
      'a MiConnect 5xx on the user read',
      { ...OPEN_WORLD, status: { users: 502 } },
      UUID,
      HandoffAccessClass.refused,
    ],
    [
      'a uuid that matches two users',
      {
        ...OPEN_WORLD,
        users: [
          { pk: 7, is_active: true },
          { pk: 8, is_active: true },
        ],
      },
      UUID,
      HandoffAccessClass.refused,
    ],
  ])('refuses %s', async (_label, world, uuid, expected) => {
    const { access } = build(world, uuid);
    const e = await refusal(access.assertMayEnter('user-a', 'migallery'));
    expect(e.accessClass).toBe(expected);
  });

  it('refuses without a token, asking MiConnect nothing', async () => {
    delete process.env.MICONNECT_READER_TOKEN;
    const { access, calls } = build(OPEN_WORLD);
    const e = await refusal(access.assertMayEnter('user-a', 'migallery'));
    expect(e.accessClass).toBe(HandoffAccessClass.notConfigured);
    expect(e.unavailable).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('never puts the reader token in a log line', async () => {
    const { access } = build({ ...OPEN_WORLD, status: { app: 403 } });
    await refusal(access.assertMayEnter('user-a', 'migallery'));
    await access.reportBindings();
    for (const line of lines) expect(line).not.toContain(TOKEN);
  });

  describe('the boot watch', () => {
    it('says, per handoff application, that it may mint', async () => {
      const { access, calls } = build(OPEN_WORLD);
      await access.reportBindings();
      const apps = calls
        .map((c) => new URL(c.url).pathname)
        .filter((p) => p.startsWith('/api/v3/core/applications/'));
      expect(apps.sort()).toEqual([
        '/api/v3/core/applications/cercle/',
        '/api/v3/core/applications/migallery/',
        '/api/v3/core/applications/sky/',
      ]);
      expect(
        lines.filter((l) =>
          l.includes(
            'bindings=0 flow_bindings=0 flow_auth=require_authenticated default_access=unset'
          )
        )
      ).toHaveLength(3);
    });

    it('names, at warn, an application that gained a binding', async () => {
      const { access } = build({ ...OPEN_WORLD, bindings: 2 });
      const warned: string[] = [];
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
        warned.push(String(m));
      });
      await access.reportBindings();
      expect(warned).toHaveLength(3);
      expect(warned[0]).toMatch(/site=migallery app=migallery bindings=2 .*REFUSED policy_bound/);
    });

    it('logs a failed read at error and does not throw', async () => {
      const { access } = build({ ...OPEN_WORLD, down: true });
      await expect(access.reportBindings()).resolves.toBeUndefined();
      expect(lines.filter((l) => l.includes('could not be read'))).toHaveLength(3);
    });

    it('says once that the estate holds no reader token, and reads nothing', async () => {
      delete process.env.MICONNECT_READER_TOKEN;
      const { access, calls } = build(OPEN_WORLD);
      await access.reportBindings();
      expect(calls).toHaveLength(0);
      expect(lines.filter((l) => l.includes('MICONNECT_READER_TOKEN is unset'))).toHaveLength(1);
    });
  });
});
