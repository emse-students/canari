/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MailAlertDevice } from '../entities/mail-alert-device.entity';
import { MailAlertToken } from '../entities/mail-alert-token.entity';
import type { PushToken } from '../entities/push-token.entity';
import {
  buildMailPushMessage,
  hashMailAlertToken,
  isMailAlertToken,
  mailAlertBody,
  mailAlertSecretMatches,
} from '../utils/mail-alert';
import { MAIL_ALERT_REFUSAL, MailAlertRefusal, MailAlertService } from './mail-alert.service';

const send = jest.fn();
let firebaseApps: unknown[] = [{}];
jest.mock('firebase-admin/app', () => ({ getApps: () => firebaseApps }));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ send }) }));

const TOKEN = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

/**
 * An in-memory stand-in for the three tables and `platform_config.mail_push`, enough for the
 * service's reads and writes - each rule is asserted on the rows, never on the calls.
 */
function fakeDb(mode: string | null = 'cloudflare') {
  const tokens: { userId: string; tokenHash: string }[] = [];
  const devices: { userId: string; deviceId: string }[] = [];
  const push: Partial<PushToken>[] = [];
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const table = (entity: unknown) => (entity === MailAlertToken ? tokens : devices);
  const manager = {
    query: jest.fn(async () => (mode === null ? [] : [{ mail_push: mode }])),
    findOne: async (entity: unknown, { where }: { where: Record<string, unknown> }) =>
      (table(entity) as Record<string, unknown>[]).find((r) => match(r, where)) ?? null,
    upsert: async (entity: unknown, value: Record<string, string>, keys: string[]) => {
      const rows = table(entity) as Record<string, unknown>[];
      const at = rows.findIndex((r) => keys.every((k) => r[k] === value[k]));
      if (at >= 0) rows[at] = { ...rows[at], ...value };
      else rows.push({ ...value });
    },
    delete: async (entity: unknown, where: Record<string, unknown>) => {
      const rows = table(entity) as Record<string, unknown>[];
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1);
    },
    count: async (entity: unknown, { where }: { where: Record<string, unknown> }) =>
      (table(entity) as Record<string, unknown>[]).filter((r) => match(r, where)).length,
    transaction: async <T>(work: (m: unknown) => Promise<T>) => work(manager),
  };
  const repoOf = <T>(rows: Record<string, unknown>[]) =>
    ({
      manager,
      findOne: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => match(r, where)) ?? null,
      find: async ({ where }: { where: Record<string, unknown> | Record<string, unknown>[] }) => {
        const all = Array.isArray(where) ? where : [where];
        return rows.filter((r) => all.some((w) => match(r, w)));
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => match(r, where)).length,
      exists: async ({ where }: { where: Record<string, unknown> }) =>
        rows.some((r) => match(r, where)),
      delete: async (where: Record<string, unknown>) => {
        for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1);
      },
    }) as unknown as Repository<T>;
  const service = new MailAlertService(
    repoOf<MailAlertToken>(tokens),
    repoOf<MailAlertDevice>(devices),
    repoOf<PushToken>(push as Record<string, unknown>[])
  );
  return { service, tokens, devices, push };
}

describe('mail alert - the pure rules', () => {
  it('a token is exactly 32 lower-case hex characters', () => {
    expect(isMailAlertToken(TOKEN)).toBe(true);
    for (const bad of [TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}0`, '', null, 42, 'n-x']) {
      expect(isMailAlertToken(bad)).toBe(false);
    }
  });

  it('stores a token as its SHA-256, never the token', () => {
    expect(hashMailAlertToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMailAlertToken(TOKEN)).not.toContain(TOKEN);
  });

  it('checks the secret, and an estate with no secret refuses everything', () => {
    expect(mailAlertSecretMatches('s3cret', 's3cret')).toBe(true);
    expect(mailAlertSecretMatches('s3cret ', 's3cret')).toBe(false);
    expect(mailAlertSecretMatches('other', 's3cret')).toBe(false);
    expect(mailAlertSecretMatches(undefined, 's3cret')).toBe(false);
    expect(mailAlertSecretMatches('', '')).toBe(false);
    expect(mailAlertSecretMatches('anything', undefined)).toBe(false);
  });

  it('the push is EMPTY: only type=mail, on both platforms', () => {
    const android = buildMailPushMessage({ token: 'a', platform: 'android', locale: 'fr' });
    expect(android).toEqual({
      token: 'a',
      data: { type: 'mail' },
      android: { priority: 'high', ttl: 86_400_000 },
    });
    const ios = buildMailPushMessage({ token: 'i', platform: 'ios', locale: 'en' }) as {
      apns: { payload: Record<string, unknown>; headers: Record<string, string> };
    };
    const { aps, ...rest } = ios.apns.payload as { aps: Record<string, unknown> };
    expect(rest).toEqual({ type: 'mail' });
    expect(aps).toMatchObject({
      'mutable-content': 1,
      alert: { title: 'Canari', body: 'New mail' },
    });
    expect(aps).not.toHaveProperty('thread-id');
    expect(ios.apns.headers).toEqual({ 'apns-push-type': 'alert', 'apns-priority': '10' });
    expect(mailAlertBody(null)).toBe('Nouveau mail');
  });
});

describe('MailAlertService', () => {
  beforeAll(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  beforeEach(() => {
    send.mockReset();
    firebaseApps = [{}];
    process.env.MAIL_ALERT_DOMAIN = 'Alerte.Example.org';
  });

  it('refuses a subscription while mail_push is none, or with no domain, or with no push registration', async () => {
    const off = fakeDb('none');
    await expect(off.service.subscribe('u1', 'd1', TOKEN)).rejects.toMatchObject({
      error: MAIL_ALERT_REFUSAL.off,
      status: 409,
    });
    const absentRow = fakeDb(null);
    await expect(absentRow.service.subscribe('u1', 'd1', TOKEN)).rejects.toBeInstanceOf(
      MailAlertRefusal
    );

    const db = fakeDb();
    process.env.MAIL_ALERT_DOMAIN = '';
    await expect(db.service.subscribe('u1', 'd1', TOKEN)).rejects.toMatchObject({
      error: MAIL_ALERT_REFUSAL.unconfigured,
    });
    process.env.MAIL_ALERT_DOMAIN = 'alerte.example.org';
    await expect(db.service.subscribe('u1', 'd1', TOKEN)).rejects.toMatchObject({
      error: MAIL_ALERT_REFUSAL.notRegistered,
    });
    expect(db.tokens).toEqual([]);
  });

  it('subscribes idempotently, rotates the token, and drops it with the last device', async () => {
    const db = fakeDb();
    db.push.push(
      { id: 'p1', userId: 'u1', deviceId: 'd1' },
      { id: 'p2', userId: 'u1', deviceId: 'd2' }
    );

    expect(await db.service.subscribe('u1', 'd1', TOKEN)).toEqual({ domain: 'alerte.example.org' });
    await db.service.subscribe('u1', 'd1', TOKEN);
    expect(db.tokens).toEqual([{ userId: 'u1', tokenHash: hashMailAlertToken(TOKEN) }]);
    expect(db.devices).toHaveLength(1);

    await db.service.subscribe('u1', 'd2', OTHER);
    expect(db.tokens).toEqual([{ userId: 'u1', tokenHash: hashMailAlertToken(OTHER) }]);
    expect(db.devices).toHaveLength(2);

    expect(await db.service.unsubscribe('u1', 'd1')).toEqual({ remaining: 1 });
    expect(db.tokens).toHaveLength(1);
    expect(await db.service.unsubscribe('u1', 'd2')).toEqual({ remaining: 0 });
    expect(db.tokens).toEqual([]);
    expect(await db.service.unsubscribe('u1', 'd2')).toEqual({ remaining: 0 });
  });

  it('answers whether a token read from the alert is the live one', async () => {
    const db = fakeDb();
    db.push.push({ id: 'p1', userId: 'u1', deviceId: 'd1' });
    await db.service.subscribe('u1', 'd1', TOKEN);
    expect(await db.service.state('u1', 'd2', TOKEN)).toEqual({
      mode: 'cloudflare',
      domain: 'alerte.example.org',
      deviceSubscribed: false,
      tokenLive: true,
      devices: 1,
    });
    expect((await db.service.state('u1', 'd1', OTHER)).tokenLive).toBe(false);
    expect((await db.service.state('u1', 'd1', null)).tokenLive).toBe(false);
    expect((await db.service.state('u2', 'd1', TOKEN)).tokenLive).toBe(false);
  });

  it('an alert pushes the empty message to every subscribed device, and only to them', async () => {
    const db = fakeDb();
    db.push.push(
      { id: 'p1', userId: 'u1', deviceId: 'd1', token: 'fcm1', platform: 'android', locale: 'fr' },
      { id: 'p2', userId: 'u1', deviceId: 'd2', token: 'apns2', platform: 'ios', locale: 'fr' },
      { id: 'p3', userId: 'u1', deviceId: 'd3', token: 'fcm3', platform: 'android', locale: 'fr' }
    );
    await db.service.subscribe('u1', 'd1', TOKEN);
    await db.service.subscribe('u1', 'd2', TOKEN);
    send.mockResolvedValue('ok');

    expect(await db.service.alert(TOKEN)).toEqual({ status: 'pushed', sent: 2, failed: 0 });
    const tokens = send.mock.calls.map((c) => (c[0] as { token: string }).token).sort();
    expect(tokens).toEqual(['apns2', 'fcm1']);
    expect(send.mock.calls[0][0].data ?? send.mock.calls[0][0].apns.payload.type).toBeTruthy();
  });

  it('one refused device does not stop the others', async () => {
    const db = fakeDb();
    db.push.push(
      { id: 'p1', userId: 'u1', deviceId: 'd1', token: 'bad', platform: 'android', locale: null },
      { id: 'p2', userId: 'u1', deviceId: 'd2', token: 'good', platform: 'android', locale: null }
    );
    await db.service.subscribe('u1', 'd1', TOKEN);
    await db.service.subscribe('u1', 'd2', TOKEN);
    send.mockImplementation(async (m: { token: string }) => {
      if (m.token === 'bad')
        throw Object.assign(new Error('x'), { code: 'messaging/internal-error' });
      return 'ok';
    });
    expect(await db.service.alert(TOKEN)).toEqual({ status: 'pushed', sent: 1, failed: 1 });
  });

  it('an unknown token, the switch off, and a token with no device left push nothing', async () => {
    const off = fakeDb('none');
    expect(await off.service.alert(TOKEN)).toEqual({ status: 'off' });

    const db = fakeDb();
    expect(await db.service.alert(TOKEN)).toEqual({ status: 'unknown' });

    db.push.push({ id: 'p1', userId: 'u1', deviceId: 'd1' });
    await db.service.subscribe('u1', 'd1', TOKEN);
    db.push.splice(0, 1); // the registration went (the cascade would take the device row too)
    expect(await db.service.alert(TOKEN)).toEqual({ status: 'no_device' });
    expect(db.tokens).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
