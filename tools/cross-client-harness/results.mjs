/**
 * Append-only result log for the campaign.
 *
 * A check that passes earns a row in section 10 of the wiki page and nothing else; a check that
 * fails earns a Work Package with its captured log. Both need the raw record to have survived the
 * session, so every runner writes here rather than only to stdout.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const FILE = new URL('./results.ndjson', import.meta.url);

export function record(id, verdict, detail) {
  const row = { id, verdict, at: new Date().toISOString(), ...detail };
  appendFileSync(FILE, `${JSON.stringify(row)}\n`);
  console.log(`[${verdict}] ${id} ${JSON.stringify(detail)}`);
  return row;
}

export function all() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A short unique marker, so two runs of the same check never collide in the history. */
export const mark = (id) => `${id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
