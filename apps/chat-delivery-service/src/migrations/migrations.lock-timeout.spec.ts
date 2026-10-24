import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A migration that locks `queued_message` - the table every send writes and every pull reads - must
 * give up rather than queue behind a long transaction: ALTER TABLE takes ACCESS EXCLUSIVE, and every
 * send and pull waits behind a lock request that is itself waiting. `SET lock_timeout` makes the
 * deploy fail loudly instead, and the migration is idempotent, so a re-run is safe.
 *
 * Asserted from 035 on; older migrations ran before the rule and are not re-run.
 */
const MIGRATIONS = join(process.cwd(), 'src', 'migrations');

function read(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

describe('a migration that locks a table every send reads', () => {
  it('035 sets a lock_timeout before it alters the table', () => {
    const sql = read('035_queued_message_addressed.sql');
    const timeout = sql.search(/^\s*SET\s+lock_timeout\s*=\s*'\d+s'\s*;/im);
    const alter = sql.search(/^\s*ALTER\s+TABLE\s+queued_message/im);

    expect(alter).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeLessThan(alter);
  });

  // `push_token` is read by every send to find its destinations: the same reason, another table.
  it('037 sets a lock_timeout before it alters push_token', () => {
    const sql = read('037_push_token_session.sql');
    const timeout = sql.search(/^\s*SET\s+lock_timeout\s*=\s*'\d+s'\s*;/im);
    const alter = sql.search(/^\s*ALTER\s+TABLE\s+"?push_token"?/im);

    expect(alter).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeLessThan(alter);
  });
});
