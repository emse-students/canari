import { Logger } from '@nestjs/common';
import { DataSource, type DataSourceOptions } from 'typeorm';

const logger = new Logger('SynchronizePrerequisites');

/**
 * The extensions an entity's DDL needs BEFORE `synchronize` can build it.
 *
 * `btree_gist`: the `bookings_live_no_overlap` exclusion (`Booking`) compares a uuid with `=` inside
 * a GiST index. In production migration 087 creates the extension before the constraint; a database
 * built by `synchronize` (development, the CI boot probe) has no migration, so the extension must be
 * created here or the boot dies on "data type uuid has no default operator class for access method
 * gist". It is the SAME prerequisite on the other path, not a second way to the constraint.
 */
export const SYNCHRONIZE_EXTENSIONS = ['btree_gist'] as const;

/** The two calls of a DataSource this step makes, so a spec can watch their order. */
export interface SchemaBuilder {
  query(sql: string): Promise<unknown>;
  synchronize(): Promise<void>;
}

/**
 * Creates the extensions `synchronize` needs, then synchronises. Called ONLY when the options ask
 * for `synchronize`: production (`synchronize: false`) gets its schema, extensions included, from
 * the migrations, and this step must not touch it.
 */
export async function synchronizeWithPrerequisites(ds: SchemaBuilder): Promise<void> {
  for (const extension of SYNCHRONIZE_EXTENSIONS) {
    logger.debug(`synchronize: ensuring extension ${extension}`);
    await ds.query(`CREATE EXTENSION IF NOT EXISTS ${extension} SCHEMA public`);
  }
  logger.debug('synchronize: building the schema from the entities');
  await ds.synchronize();
}

/**
 * The `dataSourceFactory` of the root TypeORM module. With `synchronize` off (production) it is
 * TypeORM's own construction, untouched. With it on, the DataSource is initialised WITHOUT
 * synchronising, the prerequisites are created, and only then is the schema built - TypeORM offers
 * no hook between connecting and synchronising, so the two steps are split here. A failure destroys
 * the half-built DataSource so the module's retry does not leak a connection pool.
 */
export async function createDataSource(options: DataSourceOptions): Promise<DataSource> {
  if (!options.synchronize) {
    logger.debug('synchronize off: schema comes from the migrations');
    return new DataSource(options).initialize();
  }
  const ds = await new DataSource({ ...options, synchronize: false }).initialize();
  try {
    await synchronizeWithPrerequisites(ds);
    return ds;
  } catch (err) {
    logger.error(`synchronize failed: ${(err as Error).message}`);
    await ds.destroy();
    throw err;
  }
}
