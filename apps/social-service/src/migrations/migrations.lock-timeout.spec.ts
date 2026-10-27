import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A migration that locks a table must give up rather than queue behind a long transaction: ALTER
 * TABLE takes ACCESS EXCLUSIVE, and every request on that table waits behind a lock request that is
 * itself waiting. `SET lock_timeout` makes the deploy fail loudly instead, and the migrations are
 * idempotent, so a re-run is safe. The same rule as chat-delivery-service's spec of that name.
 *
 * Asserted from 108 on, the first migration of this service written under the rule; older ones ran
 * before it and are never re-run on an estate that has them.
 */
const MIGRATIONS = join(process.cwd(), 'src', 'migrations');
const FIRST_UNDER_THE_RULE = 108;

/**
 * The first statement that takes a table lock: an ALTER, a CREATE TABLE or INDEX, a DROP. Not
 * global, so `test` holds no `lastIndex` between files.
 */
const TAKES_A_LOCK =
  /^\s*(ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?(INDEX|TABLE)|DROP\s+(INDEX|TABLE))/im;

const read = (name: string): string => readFileSync(join(MIGRATIONS, name), 'utf8');

const underTheRule = readdirSync(MIGRATIONS)
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .filter((name) => Number(name.slice(0, 3)) >= FIRST_UNDER_THE_RULE);

describe('a migration from 108 on', () => {
  it('exists, so the rule below is asserted on something', () => {
    expect(underTheRule.length).toBeGreaterThan(0);
  });

  // A data-only migration (DML, no DDL) takes only row locks and owes nothing here.
  it.each(underTheRule.filter((name) => TAKES_A_LOCK.test(read(name))))(
    '%s sets a lock_timeout before its first lock',
    (name) => {
      const sql = read(name);
      const timeout = sql.search(/^\s*SET\s+lock_timeout\s*=\s*'\d+s'\s*;/im);
      const lock = sql.search(TAKES_A_LOCK);

      expect(timeout).toBeGreaterThanOrEqual(0);
      expect(timeout).toBeLessThan(lock);
    }
  );
});
