/**
 * A fake of the query builder `ChannelService.updateWorkspaceMemberRole` writes a role through:
 * `update(ChannelMember).set({ roleIds }).where('id = :memberId').andWhere('"roleIds" = :judged')`.
 *
 * It applies the update to the spec's in-memory `rows` exactly as the SQL would - by id, and only
 * while the stored roles, comma-joined as `simple-array` stores them, are the ones judged - and
 * answers `affected`. It never inserts. The race itself is proven on PostgreSQL, in
 * `member-write-gone.integration.spec.ts`.
 */
export function roleUpdateBuilder(rows: Array<{ id?: string; roleIds?: string[] }>) {
  const params: Record<string, unknown> = {};
  let roleIds: string[] = [];
  const builder = {
    update: () => builder,
    set: (s: { roleIds: string[] }) => {
      roleIds = s.roleIds;
      return builder;
    },
    where: (_sql: string, p: Record<string, unknown>) => {
      Object.assign(params, p);
      return builder;
    },
    andWhere: (_sql: string, p: Record<string, unknown>) => {
      Object.assign(params, p);
      return builder;
    },
    execute: () => {
      const hit = rows.filter(
        (r) => r.id === params.memberId && (r.roleIds ?? []).join(',') === params.judged
      );
      for (const r of hit) r.roleIds = [...roleIds];
      return Promise.resolve({ affected: hit.length });
    },
  };
  return builder;
}
