/// <reference types="jest" />

/**
 * MIGRATION 046 AND THE ENVELOPE'S LIFE, AGAINST A REAL POSTGRESQL (content-free push WP-W3,
 * docs/wiki/protocols/content-free-push.md section 10): the column and the table land and replay as
 * a no-op, and every death of an envelope deletes exactly its rows - the registration's delete by
 * the foreign key's cascade, the device's next registration by the sweep, the cap by eviction,
 * silent first - while serving never deletes, so a lost response fetched again is served the same
 * map, never `gone`.
 *
 * GATED ON `CHAT_DELIVERY_IT_DATABASE_URL`, the one name every chat-delivery integration spec reads:
 * skipped without it, and run by the `test-chat-delivery-integration` job in `ci.yml`, which refuses
 * a skip. The schema before 046 is the entities' own minus `push_envelope` and `wakeVersion`, in a
 * throwaway schema.
 *
 *   CHAT_DELIVERY_IT_DATABASE_URL=postgres://user:pass@localhost:5432/db bun run test -- 046_push_envelope
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { PushToken } from '../entities/push-token.entity';
import { PushEnvelope } from '../entities/push-envelope.entity';
import type { EnvelopeContent } from '../services/push-payload';
import {
  MAX_ENVELOPES_PER_DEVICE,
  serveEnvelope,
  storeEnvelopes,
  sweepDeviceEnvelopes,
} from '../utils/push-envelope';

const URL = process.env.CHAT_DELIVERY_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION = readFileSync(join(__dirname, '046_push_envelope.sql'), 'utf8');

const comment: EnvelopeContent = {
  title: 'Alice',
  body: 'Alice a commenté',
  data: { type: 'social', contentKey: 'social_comment', actorName: 'Alice' },
  inline: {},
};
const readOf = (channelId: string): EnvelopeContent => ({
  title: 'general',
  body: '',
  data: { type: 'channel_read', channelId },
  inline: {},
});

maybe('migration 046 (push_envelope) against PostgreSQL', () => {
  const schema = `push_envelope_it_${Date.now()}`;
  const options = { extra: { options: `-c search_path=${schema}` } };
  let admin: Client;
  let ds: DataSource;
  const logger = new Logger('push-envelope-it');

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const envelopesOf = async (userId: string, deviceId: string) =>
    (await q(
      `SELECT id, silent, "collapseKey", "servedCount" FROM push_envelope
        WHERE "userId" = $1 AND "deviceId" = $2 ORDER BY "createdAt", id`,
      [userId, deviceId]
    )) as Array<{ id: string; silent: boolean; collapseKey: string | null; servedCount: number }>;
  const register = (userId: string, deviceId: string, platform = 'android') =>
    q(
      `INSERT INTO push_token ("userId", "deviceId", token, platform, locale)
       VALUES ($1, $2, 'tok', $3, 'fr')`,
      [userId, deviceId, platform]
    );
  const store = (userId: string, deviceIds: string[], content: EnvelopeContent) =>
    storeEnvelopes(ds.manager, userId, deviceIds, content, logger, 'it');

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    // The estate before 046: `push_token` as its entity makes it, without the new column.
    const before = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PushToken],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      ...options,
    });
    await before.initialize();
    await before.synchronize();
    await before.query(`ALTER TABLE push_token DROP COLUMN "wakeVersion"`);
    await before.destroy();
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [PushToken, PushEnvelope],
      synchronize: false,
      uuidExtension: 'pgcrypto',
      installExtensions: false,
      ...options,
    });
    await ds.initialize();
    // Applied TWICE: the deploy ledger replays a file whose successor failed.
    await q(MIGRATION);
    await q(MIGRATION);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    jest.restoreAllMocks();
  }, 60_000);

  beforeEach(async () => {
    await q('DELETE FROM push_envelope');
    await q('DELETE FROM push_token');
  });

  it('adds wakeVersion at 0 for every existing row, and the entity reads it', async () => {
    await register('u1', 'pixel');
    const row = await ds.getRepository(PushToken).findOneByOrFail({ userId: 'u1' });
    expect(row.wakeVersion).toBe(0);
  });

  it('refuses an envelope for a device with no registration', async () => {
    await expect(store('u1', ['ghost'], comment)).rejects.toThrow(/foreign key/i);
    expect(await envelopesOf('u1', 'ghost')).toEqual([]);
  });

  it('serves an envelope again and again without deleting it - a lost response is never gone', async () => {
    await register('u1', 'pixel', 'ios');
    const ids = await store('u1', ['pixel'], comment);
    const id = ids.get('pixel')!;
    const first = await serveEnvelope(ds.manager, id, 'u1', 'pixel');
    const second = await serveEnvelope(ds.manager, id, 'u1', 'pixel');
    expect(first).toEqual({
      kind: 'served',
      content: comment,
      times: 1,
      platform: 'ios',
      locale: 'fr',
    });
    expect(second).toMatchObject({ kind: 'served', content: comment, times: 2 });
    expect(await envelopesOf('u1', 'pixel')).toEqual([
      { id, silent: false, collapseKey: null, servedCount: 2 },
    ]);
  });

  it("answers foreign for another registration's envelope, and gone for an unknown id", async () => {
    await register('u1', 'pixel');
    await register('u2', 'pixel');
    const id = (await store('u1', ['pixel'], comment)).get('pixel')!;
    await expect(serveEnvelope(ds.manager, id, 'u2', 'pixel')).resolves.toEqual({
      kind: 'foreign',
    });
    await expect(
      serveEnvelope(ds.manager, '99999999-9999-4999-8999-999999999999', 'u1', 'pixel')
    ).resolves.toEqual({ kind: 'gone' });
    // The foreign fetch served nothing.
    expect((await envelopesOf('u1', 'pixel'))[0].servedCount).toBe(0);
  });

  it('death 1: deleting a registration takes exactly its envelopes, by the cascade', async () => {
    await register('u1', 'pixel');
    await register('u1', 'tablet');
    await register('u2', 'pixel');
    await store('u1', ['pixel', 'tablet'], comment);
    await store('u2', ['pixel'], comment);
    await q(`DELETE FROM push_token WHERE "userId" = 'u1' AND "deviceId" = 'pixel'`);
    expect(await envelopesOf('u1', 'pixel')).toEqual([]);
    expect(await envelopesOf('u1', 'tablet')).toHaveLength(1);
    expect(await envelopesOf('u2', 'pixel')).toHaveLength(1);
  });

  it("death 2: a registration sweeps exactly its own device's envelopes", async () => {
    await register('u1', 'pixel');
    await register('u1', 'tablet');
    await store('u1', ['pixel', 'tablet'], comment);
    await store('u1', ['pixel'], comment);
    await expect(sweepDeviceEnvelopes(ds.manager, 'u1', 'pixel')).resolves.toBe(2);
    expect(await envelopesOf('u1', 'pixel')).toEqual([]);
    expect(await envelopesOf('u1', 'tablet')).toHaveLength(1);
    await expect(sweepDeviceEnvelopes(ds.manager, 'u1', 'pixel')).resolves.toBe(0);
  });

  it('death 3: the cap evicts silent envelopes first, then the oldest visible ones', async () => {
    await register('u1', 'pixel');
    // Two silent reads of different salons, then visible pushes up to the cap.
    await store('u1', ['pixel'], readOf('c-1'));
    await store('u1', ['pixel'], readOf('c-2'));
    const visible: string[] = [];
    for (let i = 0; i < MAX_ENVELOPES_PER_DEVICE - 2; i++) {
      visible.push((await store('u1', ['pixel'], comment)).get('pixel')!);
    }
    expect(await envelopesOf('u1', 'pixel')).toHaveLength(MAX_ENVELOPES_PER_DEVICE);

    // One more visible push: a silent envelope goes, every visible one stays.
    const next = (await store('u1', ['pixel'], comment)).get('pixel');
    expect(next).toBeDefined();
    let rows = await envelopesOf('u1', 'pixel');
    expect(rows).toHaveLength(MAX_ENVELOPES_PER_DEVICE);
    expect(rows.filter((r) => r.silent)).toHaveLength(1);

    // Two more: the last silent one, then the OLDEST visible one.
    await store('u1', ['pixel'], comment);
    await store('u1', ['pixel'], comment);
    rows = await envelopesOf('u1', 'pixel');
    expect(rows).toHaveLength(MAX_ENVELOPES_PER_DEVICE);
    expect(rows.filter((r) => r.silent)).toHaveLength(0);
    expect(rows.map((r) => r.id)).not.toContain(visible[0]);
    expect(rows.map((r) => r.id)).toContain(visible[1]);
  });

  it('the cap takes a new silent envelope at once on a device full of banners, and says so', async () => {
    await register('u1', 'pixel');
    for (let i = 0; i < MAX_ENVELOPES_PER_DEVICE; i++) await store('u1', ['pixel'], comment);
    const ids = await store('u1', ['pixel'], readOf('c-1'));
    expect(ids.has('pixel')).toBe(false);
    const rows = await envelopesOf('u1', 'pixel');
    expect(rows).toHaveLength(MAX_ENVELOPES_PER_DEVICE);
    expect(rows.every((r) => !r.silent)).toBe(true);
  });

  it("collapses a salon's read envelopes to the newest, and leaves other salons' alone", async () => {
    await register('u1', 'pixel');
    await store('u1', ['pixel'], readOf('c-1'));
    await store('u1', ['pixel'], readOf('c-2'));
    const newest = (await store('u1', ['pixel'], readOf('c-1'))).get('pixel');
    const rows = await envelopesOf('u1', 'pixel');
    expect(rows.map((r) => r.collapseKey).sort()).toEqual(['channel_read:c-1', 'channel_read:c-2']);
    expect(rows.map((r) => r.id)).toContain(newest);
  });
});
