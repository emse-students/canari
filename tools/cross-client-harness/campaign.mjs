/**
 * THE CAMPAIGN LEDGER ON DISK, AND THE ONE GUARD EVERY DESTRUCTIVE GESTURE CALLS.
 *
 * The decisions are `campaign-ledger.mjs` (pure, pinned by `archive/campaign-selftest.mjs`); this
 * module binds them to the estate `SITE` names and to `STATE_DIR`. Importing it evaluates
 * `site.mjs`, which REFUSES production before any line here runs - so a guard that answers at all is
 * answering about local or dev.
 *
 * ONE FILE PER ESTATE: `STATE_DIR/campaign/<estate>.ndjson`. Dev's ownership is not local's - the
 * same group name minted on both estates is two different things, and a record from one must never
 * license a deletion on the other.
 *
 * Who writes it: the creation primitives (`groupnav.createGroup`, `createDM`, `comm.createCommunity`,
 * `createChannel`), `newdevice.mjs` for a device it mints, and `campaign-fixtures.mjs` for the
 * fixtures and the four accounts. Who reads it: `assertCampaignOwned`, called by every destructive
 * gesture (listed in the harness README, "What a row may destroy").
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CampaignOwnershipError, ledgerLine, mayDestroy, parseLedger, planSweep } from './campaign-ledger.mjs';
import { STATE_DIR } from './names.mjs';
import { ESTATE } from './site.mjs';

/** This estate's ledger file. */
export const LEDGER_FILE = join(STATE_DIR, 'campaign', `${ESTATE}.ndjson`);

/** The ledger as it stands now - read on every call, never cached, because runners append to it. */
export function ledger() {
  if (!existsSync(LEDGER_FILE)) return [];
  const { entries, unreadable } = parseLedger(readFileSync(LEDGER_FILE, 'utf8'));
  if (unreadable.length) {
    console.log(`[campaign] ${LEDGER_FILE}: line(s) ${unreadable.join(', ')} unreadable - an ownership record may be LOST`);
  }
  return entries;
}

/**
 * Write down that the campaign created `target`. Called right after the product said it exists.
 *
 * @param {{kind: string, name?: string, id?: string, parent?: string, by?: string}} target
 */
export function recordCreated(target) {
  mkdirSync(join(STATE_DIR, 'campaign'), { recursive: true });
  appendFileSync(LEDGER_FILE, `${ledgerLine(target, new Date().toISOString())}\n`);
  console.log(`[campaign] ${ESTATE}: recorded ${target.kind} ${JSON.stringify(target.name ?? target.id)}${target.parent ? ` in ${JSON.stringify(target.parent)}` : ''}`);
}

/**
 * THE GUARD. Throws `CampaignOwnershipError` unless `target` may be destroyed on this estate.
 *
 * Called BEFORE the first click of a destructive gesture, so a refusal leaves the estate as it was.
 *
 * @param {{kind: string, name?: string, id?: string, parent?: string}} target
 * @param {string} label who is asking, for the message
 */
export function assertCampaignOwned(target, label) {
  const v = mayDestroy({ estate: ESTATE, entries: ledger(), target });
  if (!v.ok) throw new CampaignOwnershipError(`${label}: REFUSED on ${ESTATE} - ${v.reason}`, target);
  return v;
}

/** `planSweep` against this estate's ledger. */
export const planCampaignSweep = ({ candidates, only, expect }) =>
  planSweep({ estate: ESTATE, entries: ledger(), candidates, only, expect });

export { ESTATE };
