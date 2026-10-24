import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A migration that locks a hot table (`queued_message`, which every send writes and every pull reads,
 * or `dm_group_membership_intervals`, which every history answer reads) must
 * give up rather than queue behind a long transaction: ALTER TABLE takes ACCESS EXCLUSIVE, and every
 * send and pull waits behind a lock request that is itself waiting. `SET lock_timeout` makes the
 * deploy fail loudly instead, and the migration is idempotent, so a re-run is safe.
 *
 * Asserted from 035 on, plus 033 (reviewed into the rule before it shipped); older migrations ran before the rule and are not re-run.
 */
const MIGRATIONS = join(process.cwd(), 'src', 'migrations');

function read(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

describe.each([
  ['033_group_membership_interval_admitted_at.sql', 'dm_group_membership_intervals'],
  ['035_queued_message_addressed.sql', 'queued_message'],
])('a migration that locks a hot table: %s', (file, table) => {
  it('sets a lock_timeout before it alters the table', () => {
    const sql = read(file);
    const timeout = sql.search(/^\s*SET\s+lock_timeout\s*=\s*'\d+s'\s*;/im);
    const alter = sql.search(new RegExp(String.raw`^\s*ALTER\s+TABLE\s+${table}`, 'im'));

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
