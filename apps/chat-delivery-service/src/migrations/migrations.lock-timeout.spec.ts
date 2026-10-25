import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A migration that locks a hot table (`queued_message`, which every send writes and every pull reads,
 * or `dm_group_membership_intervals`, which every history answer reads) must
 * give up rather than queue behind a long transaction: ALTER TABLE takes ACCESS EXCLUSIVE, and every
 * send and pull waits behind a lock request that is itself waiting. `SET lock_timeout` makes the
 * deploy fail loudly instead, and the migration is idempotent, so a re-run is safe.
 *
 * Asserted from 034 on, plus 033 (reviewed into the rule before it shipped); older migrations ran before the rule and are not re-run.
 */
const MIGRATIONS = join(process.cwd(), 'src', 'migrations');

function read(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

/** The first statement that takes a lock on `queued_message`: an ALTER, an index on it, a drop. */
const LOCKS_QUEUE =
  /^\s*(ALTER\s+TABLE\s+queued_message|CREATE\s+(UNIQUE\s+)?INDEX[^;]*\bON\s+queued_message\b|DROP\s+INDEX)/im;

describe('a migration that locks queued_message', () => {
  it.each(['034_queued_payload.sql', '035_queued_message_addressed.sql'])(
    '%s sets a lock_timeout before it locks the table',
    (name) => {
      const sql = read(name);
      const timeout = sql.search(/^\s*SET\s+lock_timeout\s*=\s*'\d+s'\s*;/im);
      const lock = sql.search(LOCKS_QUEUE);

      expect(lock).toBeGreaterThanOrEqual(0);
      expect(timeout).toBeGreaterThanOrEqual(0);
      expect(timeout).toBeLessThan(lock);
    }
  );

  it('034 builds its queued_message index CONCURRENTLY, partial, after dropping an INVALID leftover', () => {
    const sql = read('034_queued_payload.sql');
    const build = sql.search(
      /^\s*CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"IDX_queued_message_payloadId"\s+ON\s+queued_message\s*\("payloadId"\)\s*WHERE\s+"payloadId"\s+IS\s+NOT\s+NULL\s*;/im
    );
    const dropInvalid = sql.search(
      /NOT\s+indisvalid[\s\S]*DROP\s+INDEX\s+"IDX_queued_message_payloadId"/i
    );

    expect(build).toBeGreaterThanOrEqual(0);
    expect(dropInvalid).toBeGreaterThanOrEqual(0);
    expect(dropInvalid).toBeLessThan(build);
    // A plain build of it anywhere would hold SHARE on the queue for the whole build.
    expect(sql).not.toMatch(
      /CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?"IDX_queued_message_payloadId"/i
    );
  });
});

describe.each([
  [
    '033_group_membership_interval_admitted_at.sql',
    /^\s*ALTER\s+TABLE\s+dm_group_membership_intervals/im,
  ],
  // `push_token` is read by every send to find its destinations: the same reason, another table.
  ['037_push_token_session.sql', /^\s*ALTER\s+TABLE\s+"?push_token"?/im],
  // `dm_group_members` authorises every send's sender.
  ['038_group_member_awaiting_admission.sql', /^\s*ALTER\s+TABLE\s+"?dm_group_members"?/im],
  // `dm_groups` is read by every commit, `dm_group_membership_intervals` by every history answer.
  ['039_departure_seat_generation.sql', /^\s*ALTER\s+TABLE\s+"?dm_groups"?/im],
])('a migration that locks another hot table: %s', (file, alters) => {
  it('sets a lock_timeout before it alters the table', () => {
    const sql = read(file);
    const timeout = sql.search(/^\s*SET\s+lock_timeout\s*=\s*'\d+s'\s*;/im);
    const alter = sql.search(alters);

    expect(alter).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(timeout).toBeLessThan(alter);
  });
});
