import { Logger, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import type { User } from './entities/user.entity';

/**
 * The user row a write was aimed at is not there any more: it was read, then deleted before the
 * write landed. A TYPE, so a caller that has a better answer than a 404 (the sign-in, whose answer
 * is the erasure's refusal) tells it apart without reading a message.
 */
export class UserRowGoneError extends NotFoundException {
  constructor(readonly userId: string) {
    super(`User #${userId} not found`);
  }
}

/**
 * Writes `changes` to the user `id` as ONE column-scoped `UPDATE` keyed by the id - never a `save`
 * of an entity read earlier.
 *
 * WHY NOT `save`: TypeORM's `save` of an entity it read diffs that in-memory copy against the row as
 * it stands NOW and writes every column where they differ, so a stale copy writes back every column
 * a concurrent writer changed since the read; and when the row was deleted meanwhile it INSERTS it
 * again, every column included. An `UPDATE` names only the columns this call owns, and touches only
 * a row that still exists.
 *
 * `affected !== 1` means the row is gone (or the id names none): {@link UserRowGoneError}, nothing
 * written, nothing inserted.
 *
 * @param site the caller's name, for the log line that accuses a write which found no row.
 */
export async function updateUserColumns(
  repo: Pick<Repository<User>, 'update'>,
  id: string,
  changes: QueryDeepPartialEntity<User>,
  site: string,
  logger: Logger
): Promise<void> {
  const result = await repo.update({ id }, changes);
  if (result.affected !== 1) {
    logger.warn(
      `[${site}] user row gone since its read user=${id.slice(0, 8)} affected=${result.affected ?? 'unknown'} - nothing written`
    );
    throw new UserRowGoneError(id);
  }
  logger.debug(
    `[${site}] user=${id.slice(0, 8)} columns=${Object.keys(changes as object).join(',')}`
  );
}
