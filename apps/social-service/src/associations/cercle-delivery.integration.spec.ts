/**
 * The Cercle delivery sweep and its CONDITIONAL status writes against a REAL PostgreSQL: the unit
 * spec's fake repository answers `update` as told, so only a database proves the sweep's `where`
 * (failed on their ladder, parked on their slow step or with none), its `NULLS FIRST` order, and
 * that a write expecting `parked` matches nothing once the row is `delivered`.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- cercle-delivery.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { Client } from 'pg';
import { of } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { ProductsService } from './products.service';
import { takeLogged } from '../common/testing/integration-log-guard.it-fixture';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const PRODUCT = '00000000-0000-4000-8000-00000000c001';
const HOUR = 3_600_000;

maybe('Cercle deliveries against PostgreSQL', () => {
  const schema = `cercle_delivery_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let repo: Repository<WebhookDelivery>;
  /** What the fake Cercle answers, by payment intent. */
  let answers: Record<string, number | Error>;

  function service(): ProductsService {
    const product = {
      id: PRODUCT,
      webhookUrl: 'https://cercle.test/api/canari/topup',
      webhookSecret: 's',
    };
    const httpService = {
      post: jest.fn((_url: string, payload: string) => {
        const answer = answers[JSON.parse(payload).paymentIntentId];
        if (answer instanceof Error) throw answer;
        return of({ status: answer, data: {} });
      }),
    };
    return new ProductsService(
      { findOne: jest.fn(async () => product) } as never,
      repo,
      {} as never,
      httpService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
  }

  async function insert(row: Partial<WebhookDelivery>): Promise<string> {
    const saved = await repo.save(
      repo.create({
        productId: PRODUCT,
        userId: 'user-1',
        amountCents: 500,
        attemptCount: 1,
        autoRetryCount: 0,
        ...row,
      })
    );
    return saved.id;
  }

  const statusOf = async (id: string) => (await repo.findOneByOrFail({ id })).status;

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [WebhookDelivery],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await ds.query(`CREATE TABLE webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "productId" uuid NOT NULL,
      "userId" varchar NOT NULL,
      "amountCents" int NOT NULL,
      "paymentIntentId" varchar NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      "attemptCount" int NOT NULL DEFAULT 0,
      "lastAttemptAt" timestamptz,
      "lastError" text,
      "nextAttemptAt" timestamptz,
      "autoRetryCount" int NOT NULL DEFAULT 0,
      "createdAt" timestamp NOT NULL DEFAULT now()
    )`);
    repo = ds.getRepository(WebhookDelivery);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM webhook_deliveries');
    answers = {};
  });

  it('one sweep settles each due row by its own answer, and leaves the rows not due alone', async () => {
    const past = new Date(Date.now() - HOUR);
    const later = new Date(Date.now() + HOUR);
    const credited = await insert({
      paymentIntentId: 'pi_1',
      status: 'parked',
      nextAttemptAt: past,
    });
    // Parked before the re-send existed: no step at all, due all the same.
    const legacy = await insert({ paymentIntentId: 'pi_2', status: 'parked', nextAttemptAt: null });
    const failing = await insert({
      paymentIntentId: 'pi_3',
      status: 'failed',
      nextAttemptAt: past,
    });
    const notDue = await insert({
      paymentIntentId: 'pi_4',
      status: 'parked',
      nextAttemptAt: later,
    });
    const exhausted = await insert({
      paymentIntentId: 'pi_5',
      status: 'failed',
      nextAttemptAt: null,
    });
    answers = { pi_1: 200, pi_2: 202, pi_3: new Error('Request failed with status code 503') };

    expect(await service().retryDueWebhookDeliveries()).toEqual({ delivered: 2, attempted: 3 });

    expect(await statusOf(credited)).toBe('delivered');
    const stillParked = await repo.findOneByOrFail({ id: legacy });
    expect(stillParked.status).toBe('parked');
    expect(stillParked.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 5 * HOUR);
    const failed = await repo.findOneByOrFail({ id: failing });
    expect(failed).toMatchObject({ status: 'failed', autoRetryCount: 1 });
    expect(await statusOf(notDue)).toBe('parked');
    expect(await statusOf(exhausted)).toBe('failed');
    // The one failing row says so, as the ladder does.
    takeLogged(
      'warn',
      /^\[CERCLE\] webhook attempt 2 failed: Request failed with status code 503$/
    );
    takeLogged(
      'error',
      /^\[CERCLE\] delivery failed for intent=pi_3: next automatic attempt at .*$/
    );
  });

  it('an attempt that lost the race to a delivery leaves the row delivered', async () => {
    const id = await insert({
      paymentIntentId: 'pi_race',
      status: 'parked',
      nextAttemptAt: new Date(Date.now() - HOUR),
    });
    // The sweep read the parked row; another attempt delivered it before the sweep's write.
    const staleCopy = await repo.findOneByOrFail({ id });
    await ds.query(`UPDATE webhook_deliveries SET status = 'delivered' WHERE id = $1`, [id]);
    const svc = service();
    const written = await (
      svc as unknown as {
        settleDelivery: (
          d: WebhookDelivery,
          from: WebhookDelivery['status'][],
          c: Pick<WebhookDelivery, 'status' | 'lastError' | 'nextAttemptAt'>
        ) => Promise<boolean>;
      }
    ).settleDelivery(staleCopy, ['parked'], {
      status: 'parked',
      lastError: 'socket hang up',
      nextAttemptAt: new Date(Date.now() + 6 * HOUR),
    });

    expect(written).toBe(false);
    takeLogged(
      'warn',
      /^\[CERCLE\] delivery .* intent=pi_race: not set parked - its status was no longer parked .*$/
    );
    expect(await statusOf(id)).toBe('delivered');
    // The stale copy is left as read: nothing claims the write happened.
    expect(staleCopy.status).toBe('parked');
  });
});
