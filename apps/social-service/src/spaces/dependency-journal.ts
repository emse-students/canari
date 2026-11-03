import type { EntityManager } from 'typeorm';

/**
 * Appends one `dependency_journal` line (migration 129; reform 2.7) inside the caller's transaction,
 * so a dependency change and its record commit or roll back together. `kind` is `entity` for a
 * governing parent, `space` for a space's governor; `actorId` is the user who made the change.
 * `source` says through which door: `admin` (the Dependencies panel, a space's governor, a platform
 * admin's `PATCH :id`) or `create` (the parent set when the entity was created).
 */
export async function writeDependencyJournal(
  manager: EntityManager,
  kind: 'entity' | 'space',
  subjectId: string,
  from: string | null,
  to: string | null,
  actorId: string,
  source: 'admin' | 'create'
): Promise<void> {
  await manager.query(
    `INSERT INTO dependency_journal (subject_kind, subject_id, from_id, to_id, actor, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [kind, subjectId, from, to, actorId, source]
  );
}
