/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';
import { Group } from './group.entity';

/**
 * A `TYPEORM_SYNCHRONIZE` stack builds `dm_groups` from the entity, never from the migrations, so the
 * constraints migration 056 writes must be declared here too, under the SAME names - otherwise such a
 * stack admits two live "Mes notes" for one account, which production refuses.
 */
describe('Group entity carries the constraints of migration 056', () => {
  const sql = readFileSync(
    join(__dirname, '..', 'migrations', '056_dm_groups_self_kind.sql'),
    'utf8'
  );

  it('declares the unique partial index on createdBy for a live self group', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === Group && i.name === 'idx_dm_groups_one_live_self_per_account'
    );
    expect(index).toBeDefined();
    expect(index!.unique).toBe(true);
    expect(index!.columns).toEqual(['createdBy']);
    expect(index!.where).toBe(`"kind" = 'self' AND "deletedAt" IS NULL`);
    expect(sql).toContain('idx_dm_groups_one_live_self_per_account');
    expect(sql).toContain(`WHERE "kind" = 'self' AND "deletedAt" IS NULL`);
  });

  it('declares the kind CHECK under the migration name', () => {
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === Group && c.name === 'chk_dm_groups_kind'
    );
    expect(check).toBeDefined();
    expect(check!.expression).toContain(`"kind" IN ('conversation', 'self')`);
    expect(sql).toContain('chk_dm_groups_kind');
  });
});
