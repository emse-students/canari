import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { BOOKING_ENTITIES } from '../bookings.module';
import { Booking, BOOKINGS_NO_OVERLAP, BOOKINGS_NO_OVERLAP_EXPRESSION } from './booking.entity';

/**
 * The entities and migration 087 describe ONE schema twice: production gets it from the migration,
 * a development database and the CI boot probe from `synchronize`. Nothing else compares the two,
 * so this spec requires every NAMED object the entities declare (constraints, foreign keys, indexes)
 * to exist under the same name in the migration, and the overlap rule to be the same text.
 */
describe('bookings entities against migrations 087 onwards', () => {
  // 087 and every bookings migration after it (088 renamed a column and its check), in order.
  const dir = join(__dirname, '..', '..', 'migrations');
  const migration = readdirSync(dir)
    .filter((f) => /^\d+_booking/.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  const targets = new Set<unknown>(BOOKING_ENTITIES);
  const storage = getMetadataArgsStorage();

  it('declares the overlap exclusion on Booking with the migration text', () => {
    const exclusion = storage.exclusions.find((e) => e.target === Booking);
    expect(exclusion?.name).toBe(BOOKINGS_NO_OVERLAP);
    expect(exclusion?.expression).toBe(BOOKINGS_NO_OVERLAP_EXPRESSION);
    expect(migration).toContain(
      `ADD CONSTRAINT ${BOOKINGS_NO_OVERLAP}\n      EXCLUDE ${BOOKINGS_NO_OVERLAP_EXPRESSION};`
    );
  });

  it('names every check, foreign key and index the migration creates', () => {
    const names = [
      ...storage.checks.filter((c) => targets.has(c.target)).map((c) => c.name),
      ...storage.indices.filter((i) => targets.has(i.target)).map((i) => i.name),
      ...storage.joinColumns
        .filter((j) => targets.has(j.target))
        .map((j) => j.foreignKeyConstraintName),
    ];
    expect(names.length).toBeGreaterThan(20);
    const missing = names.filter((n) => !n || !new RegExp(`\\b${n}\\b`).test(migration));
    expect(missing).toEqual([]);
  });

  it('cascades every relation, so deleting a space deletes everything (D27)', () => {
    const relations = storage.relations.filter((r) => targets.has(r.target));
    expect(relations.length).toBe(8);
    // The one exception: a deleted booking's FILE becomes an orphan the purge takes, blob first
    // (migration 092) - a cascade would drop the only record of a blob that still exists.
    expect(
      relations.filter((r) => r.options.onDelete !== 'CASCADE').map((r) => r.options.onDelete)
    ).toEqual(['SET NULL']);
    expect((migration.match(/ON DELETE CASCADE/g) ?? []).length).toBe(7);
    expect((migration.match(/ON DELETE SET NULL/g) ?? []).length).toBe(1);
  });
});
