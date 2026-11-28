import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  ALERT_CONTENT,
  ALERT_SUBJECT,
  alertAddress,
  alertRule,
  alertRuleName,
  httpMailAlertServer,
  isOurRule,
  MailAlertRulesMismatchError,
  MailAlertServerError,
  newAlertToken,
  parseAlertAddress,
  readAlertRecord,
  releaseMailAlertBeforeSignOut,
  syncMailAlert,
  type FilterRule,
  type MailAlertServer,
  type MailAlertServerState,
} from './mailAlert';
import { MailError } from './mailErrors';
import { parseFilterRules } from './zimbraParse';
import { getFilterRulesRequest, modifyFilterRulesRequest } from './zimbraRequests';

vi.mock('$lib/utils/Log', () => ({
  Log: { d: vi.fn(), i: vi.fn(), w: vi.fn(), e: vi.fn() },
}));

const DOMAIN = 'alerte.example.test';
const DEV_DOMAIN = 'alerte-dev.example.test';
const USER = 'u1';
const DEVICE = 'dev-a';

/** Rules of the user's, in the shape Zimbra answers (fields Canari never writes among them). */
const USER_RULES: FilterRule[] = [
  {
    name: 'newsletters',
    active: true,
    filterTests: [
      {
        condition: 'anyof',
        headerTest: [
          { index: 0, header: 'subject', stringComparison: 'contains', value: '[news]' },
        ],
      },
    ],
    filterActions: [
      { actionFileInto: [{ index: 0, folderPath: 'News' }], actionStop: [{ index: 1 }] },
    ],
  },
  {
    name: 'forward-boss',
    active: false,
    filterTests: [{ condition: 'allof', addressTest: [{ index: 0, header: 'from', part: 'all' }] }],
    filterActions: [{ actionRedirect: [{ index: 0, a: 'me@example.test' }] }],
  },
];

/** A memory Storage. */
function memoryStore(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

/**
 * A mailbox holding the account's filter rules as Zimbra would: `GetFilterRules` answers them in
 * order, `ModifyFilterRules` REPLACES them with what it is handed. Rules round-trip through JSON, so
 * an identity a test compares is a value, never a shared object. `beforeRead` lets a test change the
 * list as another client would, right before the Nth read.
 */
function fakeMailbox(initial: FilterRule[] = []) {
  let rules: FilterRule[] = structuredClone(initial);
  const writes: FilterRule[][] = [];
  let failWrite = false;
  let reads = 0;
  const hooks = new Map<number, (r: FilterRule[]) => FilterRule[]>();
  let mangle: ((r: FilterRule[]) => FilterRule[]) | null = null;
  const call = vi.fn(async (body: Record<string, any>) => {
    if (body.GetFilterRulesRequest) {
      reads++;
      const hook = hooks.get(reads);
      if (hook) rules = hook(rules);
      return { GetFilterRulesResponse: { filterRules: [{ filterRule: structuredClone(rules) }] } };
    }
    if (body.ModifyFilterRulesRequest) {
      if (failWrite) throw new Error('write refused');
      rules = structuredClone(body.ModifyFilterRulesRequest.filterRules[0].filterRule);
      if (mangle) rules = mangle(rules);
      writes.push(rules);
      return { ModifyFilterRulesResponse: {} };
    }
    throw new Error('unexpected request');
  });
  return {
    mailbox: { call } as any,
    rules: () => rules,
    set(next: FilterRule[]) {
      rules = structuredClone(next);
    },
    beforeRead(n: number, change: (r: FilterRule[]) => FilterRule[]) {
      hooks.set(reads + n, change);
    },
    mangleWrites(change: (r: FilterRule[]) => FilterRule[]) {
      mangle = change;
    },
    reads: () => reads,
    writes,
    failNextWrites() {
      failWrite = true;
    },
  };
}

/** The token this estate's rule names now, or `null`. */
function ruleToken(rules: FilterRule[], domain = DOMAIN): string | null {
  const ours = rules.find((r) => isOurRule(r, domain)) as any;
  return ours ? parseAlertAddress(ours.filterActions[0].actionNotify[0].a)!.token : null;
}

/** A server holding one token per account and the devices that subscribed to it. */
function fakeServer(mode: 'none' | 'cloudflare' = 'cloudflare', domain: string | null = DOMAIN) {
  let token: string | null = null;
  const devices = new Set<string>();
  let taken = 0;
  const server: MailAlertServer & { mode: typeof mode } = {
    mode,
    state: vi.fn(async (deviceId: string, asked: string | null): Promise<MailAlertServerState> => ({
      mode: server.mode,
      domain,
      deviceSubscribed: devices.has(deviceId),
      tokenLive: asked !== null && asked === token && devices.size > 0,
      devices: devices.size,
      accountToken: token !== null,
    })),
    subscribe: vi.fn(async (deviceId: string, t: string) => {
      if (server.mode !== 'cloudflare') throw new MailAlertServerError('off', 409);
      if (taken > 0) {
        taken--;
        throw new MailAlertServerError('token_taken', 409);
      }
      if (t !== token) devices.clear();
      token = t;
      devices.add(deviceId);
      return { domain: domain! };
    }),
    unsubscribe: vi.fn(async (deviceId: string) => {
      devices.delete(deviceId);
      if (devices.size === 0) token = null;
      return { remaining: devices.size };
    }),
  };
  return {
    server,
    devices,
    token: () => token,
    takeNext(n: number) {
      taken = n;
    },
  };
}

describe('the opaque address', () => {
  it('round-trips a token and refuses any other shape', () => {
    const token = 'a'.repeat(32);
    expect(alertAddress(token, 'ALERTE.Example.test')).toBe(`n-${token}@alerte.example.test`);
    expect(parseAlertAddress(alertAddress(token, DOMAIN))).toEqual({ token, domain: DOMAIN });
    expect(parseAlertAddress('me@example.test')).toBeNull();
    expect(parseAlertAddress(`n-${'a'.repeat(31)}@x.test`)).toBeNull();
    expect(parseAlertAddress(`n-${'g'.repeat(32)}@x.test`)).toBeNull();
    expect(parseAlertAddress('')).toBeNull();
  });

  it('a new token is 128 bits of hex', () => {
    expect(newAlertToken()).toMatch(/^[0-9a-f]{32}$/);
    expect(newAlertToken((b) => b.fill(255))).toBe('f'.repeat(32));
  });
});

describe("the estate's rule", () => {
  it('is named for the estate: production and dev never share a name', () => {
    expect(alertRuleName('alerte.canari-emse.fr')).toBe('canari-alerte');
    expect(alertRuleName('alerte-dev.canari-emse.fr')).toBe('canari-alerte-dev');
  });

  it('is the chosen shape: every mail but a delivery report, a fixed notice, kept, never stopped', () => {
    const address = alertAddress('a'.repeat(32), DOMAIN);
    const rule = alertRule(address, DOMAIN) as any;
    expect(rule.name).toBe(alertRuleName(DOMAIN));
    expect(rule.active).toBe(true);
    expect(rule.filterTests[0].condition).toBe('allof');
    const tests = rule.filterTests[0].headerTest;
    expect(tests.every((t: any) => t.negative === true)).toBe(true);
    expect(tests.map((t: any) => [t.header, t.value])).toEqual([
      ['auto-submitted', 'auto-*'],
      ['from', 'mailer-daemon'],
      ['from', 'postmaster'],
    ]);
    expect(rule.filterActions[0].actionNotify).toEqual([
      {
        index: 0,
        a: address,
        su: ALERT_SUBJECT,
        content: [{ _content: ALERT_CONTENT }],
        maxBodySize: 0,
      },
    ]);
    expect(rule.filterActions[0].actionKeep).toEqual([{ index: 1 }]);
    expect(rule.filterActions[0].actionStop).toBeUndefined();
  });

  it("is recognised by the estate's name AND an address on the estate's domain, never by one alone", () => {
    const address = alertAddress('a'.repeat(32), DOMAIN);
    expect(isOurRule(alertRule(address, DOMAIN), DOMAIN)).toBe(true);
    expect(isOurRule({ ...alertRule(address, DOMAIN), name: 'my-alert' }, DOMAIN)).toBe(false);
    expect(isOurRule(alertRule('me@example.test', DOMAIN), DOMAIN)).toBe(false);
    const devAddress = alertAddress('a'.repeat(32), DEV_DOMAIN);
    expect(isOurRule(alertRule(devAddress, DEV_DOMAIN), DOMAIN)).toBe(false);
    expect(
      isOurRule({ ...alertRule(devAddress, DEV_DOMAIN), name: alertRuleName(DOMAIN) }, DOMAIN)
    ).toBe(false);
    for (const rule of USER_RULES) expect(isOurRule(rule, DOMAIN)).toBe(false);
  });
});

describe('the Zimbra filter-rule requests', () => {
  it('reads the rules in order, and refuses an answer without its rule list', () => {
    expect(getFilterRulesRequest()).toEqual({ GetFilterRulesRequest: { _jsns: 'urn:zimbraMail' } });
    expect(
      parseFilterRules({ GetFilterRulesResponse: { filterRules: [{ filterRule: USER_RULES }] } })
    ).toEqual(USER_RULES);
    expect(parseFilterRules({ GetFilterRulesResponse: { filterRules: [{}] } })).toEqual([]);
    expect(() => parseFilterRules({ GetFilterRulesResponse: {} })).toThrow(MailError);
  });

  it('writes the whole list in the measured shape', () => {
    expect(modifyFilterRulesRequest(USER_RULES)).toEqual({
      ModifyFilterRulesRequest: {
        _jsns: 'urn:zimbraMail',
        filterRules: [{ filterRule: USER_RULES }],
      },
    });
  });
});

describe('syncMailAlert', () => {
  const deps = (
    mailbox: any,
    server: MailAlertServer,
    store: Storage,
    deviceId = DEVICE,
    onOptOut?: () => void
  ) => ({ userId: USER, deviceId, mailbox, server, store, onOptOut });

  it("puts the estate's rule LAST, keeps the user's verbatim, and removes only ours", async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, token } = fakeServer();
    const store = memoryStore();

    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('configured');
    expect(isOurRule(box.rules().at(-1)!, DOMAIN)).toBe(true);
    expect(ruleToken(box.rules())).toBe(token());
    expect(box.rules().slice(0, -1)).toEqual(USER_RULES);
    expect(readAlertRecord(USER, store)).toEqual({ v: 1, subscribed: true });

    expect(await syncMailAlert(deps(box.mailbox, server, store), false)).toBe('removed');
    expect(box.rules()).toEqual(USER_RULES);
    expect(readAlertRecord(USER, store)).toBeNull();
    expect(token()).toBeNull();
  });

  it("never touches the other estate's rule, whatever either estate does", async () => {
    const devRule = alertRule(alertAddress('d'.repeat(32), DEV_DOMAIN), DEV_DOMAIN);
    const box = fakeMailbox([...USER_RULES, devRule]);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(box.rules().slice(0, -1)).toEqual([...USER_RULES, devRule]);
    await syncMailAlert(deps(box.mailbox, server, store), false);
    expect(box.rules()).toEqual([...USER_RULES, devRule]);
    // A device of this estate that never subscribed, the switch at none: still never the dev rule.
    const off = fakeServer('none');
    expect(await syncMailAlert(deps(box.mailbox, off.server, memoryStore()), false)).toBe(
      'unchanged'
    );
    expect(box.rules()).toEqual([...USER_RULES, devRule]);
  });

  it('an account with no rule gets ours alone, and is left with none', async () => {
    const box = fakeMailbox([]);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(box.rules()).toHaveLength(1);
    await syncMailAlert(deps(box.mailbox, server, store), false);
    expect(box.rules()).toEqual([]);
  });

  it('is idempotent: a second sync writes nothing', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(await syncMailAlert(deps(box.mailbox, server, store), true)).toBe('unchanged');
    expect(box.writes).toHaveLength(1);
  });

  it('a second device joins the token read back from the rule, which stays until the last leaves', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, devices } = fakeServer();
    const storeA = memoryStore();
    const storeB = memoryStore();

    await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), true);
    expect(await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), true)).toBe('joined');
    expect(devices.size).toBe(2);
    expect(box.writes).toHaveLength(1);

    expect(await syncMailAlert(deps(box.mailbox, server, storeA, 'dev-a'), false)).toBe('left');
    expect(box.rules().some((r) => isOurRule(r, DOMAIN))).toBe(true);
    expect(await syncMailAlert(deps(box.mailbox, server, storeB, 'dev-b'), false)).toBe('removed');
    expect(box.rules()).toEqual(USER_RULES);
  });

  it('the list changing between the read and the write starts the sync over, and the change is kept', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const added: FilterRule = { ...USER_RULES[0], name: 'added-meanwhile' };
    // Read 1 is the sync's own; read 2 is the guard right before the write.
    box.beforeRead(2, (r) => [added, ...r]);
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), true)).toBe('configured');
    expect(box.writes).toHaveLength(1);
    expect(box.rules().slice(0, -1)).toEqual([added, ...USER_RULES]);
  });

  it('a read-back that lost or changed a user rule is a typed error, never silent', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, devices } = fakeServer();
    box.mangleWrites((r) => r.filter((rule) => rule.name !== 'forward-boss'));
    await expect(
      syncMailAlert(deps(box.mailbox, server, memoryStore()), true)
    ).rejects.toBeInstanceOf(MailAlertRulesMismatchError);
    expect(devices.size).toBe(0);
  });

  it('a token the server says is taken is drawn again', async () => {
    const box = fakeMailbox([]);
    const fake = fakeServer();
    fake.takeNext(1);
    expect(await syncMailAlert(deps(box.mailbox, fake.server, memoryStore()), true)).toBe(
      'configured'
    );
    expect(fake.server.subscribe).toHaveBeenCalledTimes(2);
    expect(ruleToken(box.rules())).toBe(fake.token());
  });

  it('a rule the user disabled is an opt-out: never re-enabled, and the switch is turned off', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, devices } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    box.set(box.rules().map((r) => (isOurRule(r, DOMAIN) ? { ...r, active: false } : r)));
    const optOut = vi.fn();
    expect(await syncMailAlert(deps(box.mailbox, server, store, DEVICE, optOut), true)).toBe(
      'opted_out'
    );
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(devices.size).toBe(0);
    expect(box.rules().find((r) => isOurRule(r, DOMAIN))!.active).toBe(false);
    expect(box.writes).toHaveLength(1);
  });

  it('a stale rule of ours is replaced, never duplicated', async () => {
    const stale = alertRule(alertAddress('b'.repeat(32), DOMAIN), DOMAIN);
    const box = fakeMailbox([stale, ...USER_RULES]);
    const { server, token } = fakeServer();
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), true)).toBe('configured');
    expect(box.rules().filter((r) => isOurRule(r, DOMAIN))).toHaveLength(1);
    expect(ruleToken(box.rules())).toBe(token());
    expect(box.rules().slice(0, -1)).toEqual(USER_RULES);
  });

  it("a rule of the estate's name pointing elsewhere is the user's: never touched", async () => {
    const theirs = alertRule('me@example.test', DOMAIN);
    const box = fakeMailbox([theirs]);
    const { server } = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    expect(box.rules().slice(0, -1)).toEqual([theirs]);
    await syncMailAlert(deps(box.mailbox, server, store), false);
    expect(box.rules()).toEqual([theirs]);
  });

  it('repairs an orphan rule of ours, only when the server says nobody listens', async () => {
    const orphan = alertRule(alertAddress('c'.repeat(32), DOMAIN), DOMAIN);
    const box = fakeMailbox([orphan, ...USER_RULES]);
    const fake = fakeServer();
    // The account holds a (rotated) token, so a rule of ours may exist: it is read and repaired.
    fake.server.state = vi.fn(async () => ({
      mode: 'cloudflare' as const,
      domain: DOMAIN,
      deviceSubscribed: false,
      tokenLive: false,
      devices: 0,
      accountToken: true,
    }));
    expect(await syncMailAlert(deps(box.mailbox, fake.server, memoryStore()), false)).toBe(
      'repaired'
    );
    expect(box.rules()).toEqual(USER_RULES);
  });

  it('with no token on the account and no record here, the rules are not even read', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer('none');
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), false)).toBe('unchanged');
    expect(box.mailbox.call).not.toHaveBeenCalled();
  });

  it('leaves a live rule of another device alone', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    await syncMailAlert(deps(box.mailbox, server, memoryStore(), 'dev-a'), true);
    const writes = box.writes.length;
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore(), 'dev-b'), false)).toBe(
      'unchanged'
    );
    expect(box.writes).toHaveLength(writes);
  });

  it('with mail_push none: nothing is configured, and a subscribed device removes its rule', async () => {
    const box = fakeMailbox(USER_RULES);
    const fake = fakeServer();
    const store = memoryStore();
    await syncMailAlert(deps(box.mailbox, fake.server, store), true);
    fake.server.mode = 'none';
    expect(await syncMailAlert(deps(box.mailbox, fake.server, store), true)).toBe('off');
    expect(await syncMailAlert(deps(box.mailbox, fake.server, store), false)).toBe('removed');
    expect(box.rules()).toEqual(USER_RULES);
  });

  it('an estate without an alert domain configures nothing', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer('cloudflare', null);
    expect(await syncMailAlert(deps(box.mailbox, server, memoryStore()), true)).toBe(
      'unconfigured'
    );
    expect(box.writes).toHaveLength(0);
  });

  it('no device id: nothing is read or written', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const d = { ...deps(box.mailbox, server, memoryStore()), deviceId: null };
    expect(await syncMailAlert(d, true)).toBe('no_device');
    expect(box.mailbox.call).not.toHaveBeenCalled();
  });

  it('a failed write takes the subscription back and leaves the rules as they were', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server, devices } = fakeServer();
    const store = memoryStore();
    box.failNextWrites();
    await expect(syncMailAlert(deps(box.mailbox, server, store), true)).rejects.toThrow(
      'write refused'
    );
    expect(devices.size).toBe(0);
    expect(box.rules()).toEqual(USER_RULES);
    expect(readAlertRecord(USER, store)).toEqual({ v: 1, subscribed: false });
  });

  it('the sign-out release removes our rule while the session is open, and is a no-op otherwise', async () => {
    const box = fakeMailbox(USER_RULES);
    const { server } = fakeServer();
    const store = memoryStore();
    await releaseMailAlertBeforeSignOut(deps(box.mailbox, server, store));
    expect(box.mailbox.call).not.toHaveBeenCalled();
    await syncMailAlert(deps(box.mailbox, server, store), true);
    await releaseMailAlertBeforeSignOut(deps(box.mailbox, server, store));
    expect(box.rules()).toEqual(USER_RULES);
    box.failNextWrites();
    await expect(
      releaseMailAlertBeforeSignOut(deps(box.mailbox, server, store))
    ).resolves.toBeUndefined();
  });

  it('an unreadable record is ignored', () => {
    const store = memoryStore();
    store.setItem(ACCOUNT_KEY.mailAlert(USER), '{"v":2}');
    expect(readAlertRecord(USER, store)).toBeNull();
    store.setItem(ACCOUNT_KEY.mailAlert(USER), 'not json');
    expect(readAlertRecord(USER, store)).toBeNull();
  });
});

describe('httpMailAlertServer', () => {
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('posts to the delivery routes', async () => {
    const fetcher = vi.fn(async () => answer(200, { remaining: 0 }));
    await httpMailAlertServer(fetcher).unsubscribe(DEVICE);
    expect(fetcher).toHaveBeenCalledWith('/api/mls/mail-alert/unsubscribe', { deviceId: DEVICE });
  });

  it.each([
    ['mail_push_off', 'off'],
    ['mail_alert_unconfigured', 'unconfigured'],
    ['push_not_registered', 'not_registered'],
    ['mail_alert_token_taken', 'token_taken'],
    ['something_else', 'refused'],
  ])('types the refusal %s as %s', async (error, kind) => {
    const server = httpMailAlertServer(async () => answer(409, { error }));
    await expect(server.subscribe(DEVICE, 'a'.repeat(32))).rejects.toMatchObject({
      kind,
      status: 409,
    });
  });

  it('a refusal with no JSON body is refused', async () => {
    const server = httpMailAlertServer(async () => new Response('oops', { status: 502 }));
    await expect(server.state(DEVICE, null)).rejects.toBeInstanceOf(MailAlertServerError);
  });
});
