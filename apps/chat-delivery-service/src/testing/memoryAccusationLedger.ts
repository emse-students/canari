/**
 * An in-memory `report_accusations` table answering the three statements of
 * `utils/report-accusations.ts` - the claim, the release, the daily summary - with the semantics
 * PostgreSQL gives them: the claim returns only the rows it inserted or whose state it changed, the
 * release deletes and returns every row of the report its id list does not name, the summary groups
 * by report.
 *
 * For the controller's report specs, which mock every repository and need a ledger that REMEMBERS
 * across two runs. The SQL itself is proven against a real PostgreSQL by
 * `utils/report-accusations.integration.spec.ts`; any other statement throws here, so a new one cannot
 * be silently answered by this fake.
 */
export interface MemoryAccusationLedger {
  /** `report -> itemId -> row`. */
  rows: Map<string, Map<string, { state: string; accusedAt: Date }>>;
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

/** A fresh, empty ledger. `now` stamps each accusation; the specs assert on it, never on a clock. */
export function memoryAccusationLedger(
  now: () => Date = () => new Date(0)
): MemoryAccusationLedger {
  const rows = new Map<string, Map<string, { state: string; accusedAt: Date }>>();
  const of = (report: string) => {
    if (!rows.has(report)) rows.set(report, new Map());
    return rows.get(report) as Map<string, { state: string; accusedAt: Date }>;
  };
  return {
    rows,
    query(sql: string, params: unknown[] = []) {
      const text = sql.trim();
      if (text.startsWith('INSERT INTO report_accusations')) {
        const [report, ids, states] = params as [string, string[], string[]];
        const table = of(report);
        const written: { itemId: string }[] = [];
        ids.forEach((id, i) => {
          if (table.get(id)?.state === states[i]) return;
          table.set(id, { state: states[i], accusedAt: now() });
          written.push({ itemId: id });
        });
        return Promise.resolve(written);
      }
      if (text.startsWith('WITH gone AS (') && text.includes('DELETE FROM report_accusations')) {
        const [report, ids] = params as [string, string[]];
        const table = of(report);
        const left: { itemId: string; state: string; accusedAt: Date }[] = [];
        for (const [itemId, row] of table) {
          if (ids.includes(itemId)) continue;
          table.delete(itemId);
          left.push({ itemId, ...row });
        }
        return Promise.resolve(left);
      }
      if (text.startsWith('SELECT report, COUNT(*)')) {
        return Promise.resolve(
          [...rows]
            .filter(([, table]) => table.size > 0)
            .map(([report, table]) => {
              const stamps = [...table.values()].map((r) => r.accusedAt.getTime());
              return {
                report,
                known: table.size,
                firstAccused: new Date(Math.min(...stamps)),
                lastAccused: new Date(Math.max(...stamps)),
              };
            })
        );
      }
      return Promise.reject(new Error(`memoryAccusationLedger: unexpected statement ${text}`));
    },
  };
}
