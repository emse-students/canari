import { Logger } from '@nestjs/common';

/**
 * Whether TypeORM may build and ALTER the schema from the entities (`synchronize`).
 *
 * WHY AN EXPLICIT FLAG. It was `synchronize: process.env.NODE_ENV !== 'production'`, so the schema
 * of a deployed estate depended on a variable the production compose file defaults
 * (`${NODE_ENV:-production}`): one wrong line in a rendered `.env` and the service would have
 * altered production's schema at boot, outside the migration ledger and outside the owner's hold
 * on migrations (`infrastructure/lib/migration-hold.sh`, docs/wiki/cicd.md). Building a schema is
 * now asked for by name - `TYPEORM_SYNCHRONIZE=1`, set only by the local stack and the CI boot
 * probe, never by the production or dev compose files - and refused outright next to
 * `NODE_ENV=production`, whatever else is set.
 *
 * Unset or `0` is off. Any other value throws: a flag that changes a schema is not guessed.
 * A copy of this file lives in every service that owns a TypeORM schema (declared duplicates).
 */
export function typeormSynchronize(env: NodeJS.ProcessEnv = process.env): boolean {
  const logger = new Logger('TypeormSynchronize');
  const flag = env.TYPEORM_SYNCHRONIZE ?? '';
  if (flag === '' || flag === '0') {
    logger.debug('synchronize OFF: the schema comes from the migrations');
    return false;
  }
  if (flag !== '1') {
    throw new Error(
      `TYPEORM_SYNCHRONIZE must be 1, 0 or unset (got "${flag}") - refusing to start`
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'TYPEORM_SYNCHRONIZE=1 with NODE_ENV=production - refusing to start: a deployed schema changes only through a migration'
    );
  }
  logger.warn('synchronize ON (TYPEORM_SYNCHRONIZE=1): the schema is built from the entities');
  return true;
}
