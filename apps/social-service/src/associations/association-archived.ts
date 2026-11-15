import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

const logger = new Logger('AssociationArchived');

/**
 * The SQL fact "this association is archived", for a column holding an association id (or NULL):
 * true only for an existing row with `archived` set. A NULL id (a personal form or space) and an id
 * naming no row are NOT archived - the callers' own rules answer those, as they did before.
 * One definition for every by-link gate an archive closes (forms, booking spaces).
 */
export function associationArchivedSql(associationIdColumn: string): string {
  return (
    `EXISTS (SELECT 1 FROM associations archived_a ` +
    `WHERE archived_a.id = ${associationIdColumn} AND archived_a.archived IS TRUE)`
  );
}

/**
 * Whether the association `associationId` is ARCHIVED. An archive ends its active life: its forms
 * and booking spaces stop answering their respondents and bookers by link, as they already left
 * every list (docs/wiki/frontend/modules/associations.md, "What an archive closes").
 *
 * `lock: 'share'` reads the row `FOR SHARE` inside the caller's transaction: `AssociationsService
 * .update` writes `archived` under `FOR UPDATE` on that row, so an answer or a booking that read it
 * first commits before the archive lands (it was decided while the association was live), and one
 * reading after the archive sees it committed - the order the shop's checkout already takes
 * (`decidePurchase`). SHARE, so writers of one association never queue behind each other.
 */
export async function isAssociationArchived(
  manager: Pick<EntityManager, 'query'>,
  associationId: string,
  lock?: 'share'
): Promise<boolean> {
  const rows: { archived: boolean }[] = await manager.query(
    `SELECT archived IS TRUE AS archived FROM associations WHERE id = $1${lock === 'share' ? ' FOR SHARE' : ''}`,
    [associationId]
  );
  const archived = rows[0]?.archived === true;
  logger.debug(
    `[ASSO] association=${associationId.slice(0, 8)} archived=${archived}${lock ? ' (locked)' : ''}`
  );
  return archived;
}
