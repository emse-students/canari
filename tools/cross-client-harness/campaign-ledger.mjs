/**
 * WHAT THE CAMPAIGN OWNS ON AN ESTATE, AND WHETHER A DESTRUCTIVE GESTURE MAY TOUCH A THING - pure.
 *
 * WHY IT EXISTS (R5 of the 1.4.1 campaign, `docs/wiki/cross-client-campaign-1-4-1.md` section 3).
 * Until the campaign moved to `https://dev.canari-emse.fr`, the estate the rig destroyed things on
 * was its OWN: the local estate is seeded for the rig and nobody else writes there, so a NAME
 * allowlist (`debris.mjs`, `cleanup.mjs`'s shapes) was enough - a minted name proved a runner made
 * the thing. Dev is SHARED: testers keep their own conversations and communities there, and a rig
 * account can be a member of one of them (invited by a tester, or by a fixture of an older seed).
 * A gesture that opens "whatever is on screen" or "whatever matches a shape" would then write on a
 * tester's work. So on dev a destructive gesture may touch ONLY a container this campaign CREATED,
 * and "created" is a record written at creation time - the LEDGER - never an inference from a name.
 *
 * THE LEDGER is one append-only NDJSON file per estate under `STATE_DIR/campaign/` (`campaign.mjs`
 * does the I/O). One line per creation: `{kind, name, id?, parent?, by, at}`. Nothing is ever
 * removed from it: ownership of a thing the campaign made does not end when it is deleted, and a
 * retried deletion must still be allowed.
 *
 * THE RULE, PER ESTATE:
 * - `dev`: a target is destroyable only when the ledger owns it - by id when both sides carry one,
 *   by exact name (and parent, for a salon) otherwise. A sweep additionally needs `--only <ids>` and
 *   `--expect N` (`planSweep`): the caller names what it decided to destroy, and the count it saw.
 * - `local`: the rig's own estate. The ledger is written there too, but not required - the name
 *   allowlists keep deciding, exactly as before R5.
 * - anything else: refused. `site.mjs` refuses production at import; this refuses it again, here,
 *   because a destructive decision must not rest on another module's evaluation order.
 */

/** The kinds of thing the campaign creates and may later destroy. */
export const KINDS = ['account', 'dm', 'group', 'community', 'salon', 'device'];

/** Thrown when a destructive gesture targets something the campaign does not own. */
export class CampaignOwnershipError extends Error {
  /**
   * @param {string} message
   * @param {object} target what was refused
   */
  constructor(message, target) {
    super(message);
    this.name = 'CampaignOwnershipError';
    this.target = target;
  }
}

/**
 * One ledger line for a creation, validated.
 *
 * @param {{kind: string, name?: string|null, id?: string|null, parent?: string|null, by?: string}} t
 * @param {string} at ISO time, injected so this stays pure
 */
export function ledgerLine(t, at) {
  if (!KINDS.includes(t.kind)) throw new Error(`campaign ledger: unknown kind ${JSON.stringify(t.kind)} - one of ${KINDS.join(' ')}`);
  if (!t.name && !t.id) throw new Error(`campaign ledger: a ${t.kind} needs a name or an id to be owned by`);
  if (t.kind === 'salon' && !t.parent) throw new Error('campaign ledger: a salon is owned with its community (parent)');
  return JSON.stringify({ kind: t.kind, name: t.name ?? null, id: t.id ?? null, parent: t.parent ?? null, by: t.by ?? null, at });
}

/**
 * The ledger's entries. A line that does not parse is REPORTED, never skipped in silence: an
 * unreadable line is an ownership record lost, and the guard must say so rather than refuse later
 * for a reason nobody can see.
 *
 * @param {string} text the file's content
 * @returns {{entries: object[], unreadable: number[]}} entries, and the 1-based numbers of bad lines
 */
export function parseLedger(text) {
  const entries = [];
  const unreadable = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const e = JSON.parse(line);
        if (KINDS.includes(e.kind) && (e.name || e.id)) entries.push(e);
        else unreadable.push(i + 1);
      } catch {
        unreadable.push(i + 1);
      }
    });
  return { entries, unreadable };
}

/**
 * The ledger entry that owns `target`, or null.
 *
 * BY ID WHEN BOTH SIDES HAVE ONE: an id is what the server deletes by. Otherwise by EXACT name -
 * the primitives record a runner's minted name at creation, before any id is readable - and a salon
 * by name AND community, because two communities may each hold a `general`.
 *
 * @param {object[]} entries from `parseLedger`
 * @param {{kind: string, name?: string|null, id?: string|null, parent?: string|null}} target
 */
export function ownerOf(entries, target) {
  for (const e of entries) {
    if (e.kind !== target.kind) continue;
    if (e.id && target.id) {
      if (e.id === target.id) return e;
      continue;
    }
    if (!e.name || !target.name || e.name !== target.name) continue;
    if (target.kind === 'salon' && e.parent !== target.parent) continue;
    return e;
  }
  return null;
}

const describe = (t) => `${t.kind} ${t.kind === 'salon' ? `${JSON.stringify(t.parent)}/` : ''}${JSON.stringify(t.name ?? t.id)}`;

/**
 * Whether one destructive gesture may touch `target` on `estate`.
 *
 * @param {{estate: string, entries: object[], target: object}} p
 * @returns {{ok: boolean, reason: string, owner: object|null}}
 */
export function mayDestroy({ estate, entries, target }) {
  if (estate === 'local') {
    return { ok: true, reason: 'local estate: the rig owns all of it; the name allowlists decide', owner: ownerOf(entries, target) };
  }
  if (estate !== 'dev') {
    return { ok: false, reason: `estate ${JSON.stringify(estate)} is not one the rig may destroy anything on`, owner: null };
  }
  const owner = ownerOf(entries, target);
  return owner
    ? { ok: true, reason: `campaign-owned since ${owner.at} (${owner.by ?? 'unknown creator'})`, owner }
    : {
        ok: false,
        reason:
          `${describe(target)} is not in the campaign ledger for dev - dev is shared with testers, and the ` +
          `rig destroys only what it created (build it with campaign-fixtures.mjs, or through a primitive that records it)`,
        owner: null,
      };
}

/**
 * Which of a sweep's candidates may actually be destroyed - the `--only <ids> --expect N` contract.
 *
 * A SWEEP DECIDES ON A LIST, AND THE LIST CAN CHANGE BETWEEN THE LOOK AND THE ACT. So on dev the
 * caller must NAME every id it decided to destroy (`only`) and the count it expects (`expect`), and
 * the whole sweep is refused - nothing partial - when:
 * - `only` or `expect` is absent (an absent allowlist allows nothing);
 * - `expect` differs from the number of ids named;
 * - a named id is not among the candidates (the estate moved since the caller looked);
 * - a named id is not campaign-owned.
 * Candidates that were not named are LEFT and listed.
 *
 * On local the contract is opt-in: without `only`, every candidate the name allowlist matched is a
 * target, as before R5; with it, the same count and membership checks apply (ownership aside).
 *
 * @param {{estate: string, entries: object[], candidates: {kind: string, name?: string, id: string, parent?: string}[],
 *   only?: string[]|null, expect?: number|null}} p
 * @returns {{ok: boolean, targets: object[], left: object[], refusals: string[]}}
 */
export function planSweep({ estate, entries, candidates, only = null, expect = null }) {
  const refusals = [];
  if (estate !== 'local' && estate !== 'dev') {
    return { ok: false, targets: [], left: candidates, refusals: [`estate ${JSON.stringify(estate)} is refused`] };
  }
  if (estate === 'local' && (only === null || only.length === 0) && expect === null) {
    return { ok: true, targets: candidates, left: [], refusals };
  }
  if (!only || only.length === 0) refusals.push('--only <ids> is required: an absent allowlist allows nothing');
  if (expect === null || !Number.isInteger(expect)) refusals.push('--expect N is required');
  const named = only ?? [];
  if (expect !== null && Number.isInteger(expect) && expect !== named.length) {
    refusals.push(`--expect ${expect} but ${named.length} id(s) named`);
  }
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const targets = [];
  for (const id of named) {
    const c = byId.get(id);
    if (!c) {
      refusals.push(`${id} is not a candidate any more - the estate changed since the list was read`);
      continue;
    }
    if (estate === 'dev' && !ownerOf(entries, c)) refusals.push(`${describe(c)} (${id}) is not campaign-owned`);
    targets.push(c);
  }
  const ok = refusals.length === 0;
  return { ok, targets: ok ? targets : [], left: candidates.filter((c) => !ok || !named.includes(c.id)), refusals };
}

/** `--only a,b,c` and `--expect N` from an argv, without side effects. */
export function sweepArgs(argv) {
  const at = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? null : argv[i + 1] ?? '';
  };
  const rawOnly = at('only');
  const rawExpect = at('expect');
  return {
    only: rawOnly === null ? null : rawOnly.split(',').map((s) => s.trim()).filter(Boolean),
    expect: rawExpect === null ? null : Number(rawExpect),
  };
}

/**
 * THE FIXTURES OF THE 1.4.1 CAMPAIGN ON DEV (plan section 3, R5), as data.
 *
 * `accounts` are the keys of `test-accounts.json`; a group's `members` are the accounts the owner
 * adds (the owner is its creator). The venue is `names.mjs` `VENUE` - its public salon is
 * `VENUE.channel`, and `privateSalon` is added beside it.
 *
 * `campaign-big` IS A FIXTURE FOR BIG-2 AND BIG-3. BIG-1's own question is the ONE bulk Add that
 * creates a large group, so BIG-1 mints its own group and does not reuse this one.
 */
export const CAMPAIGN_FIXTURES = {
  accounts: ['owner', 'peer', 'third', 'fourth'],
  dm: ['owner', 'peer'],
  privateSalon: 'campaign-private',
  // EVERY ACCOUNT SITS IN THE VENUE: `archive/run.mjs`'s preflight refuses a run whose accounts are
  // not all members of it (`sharedVenue`), so a venue holding the owner and the peer alone stopped
  // every phase driving W4/W5 (2026-10-25). The owner is in it by creating it.
  venueMembers: ['peer', 'third', 'fourth'],
  groups: [
    { name: 'campaign-g2', members: ['peer'] },
    { name: 'campaign-g4', members: ['peer', 'third', 'fourth'] },
    { name: 'campaign-big', members: ['peer', 'third', 'fourth'] },
  ],
};

/**
 * What is still owed, from what the estate holds - the decision `campaign-fixtures.mjs` acts on.
 *
 * IDEMPOTENT BY CONSTRUCTION: every item is derived from an observation, so a second run over a
 * built estate owes nothing and touches nothing.
 *
 * @param {{accounts: Record<string, boolean>, dm: boolean, venue: {community: boolean, publicSalon: boolean,
 *   privateSalon: boolean, members?: string[]}, groups: Record<string, string[]|null>}} seen - `groups[name]`
 *   is the member ACCOUNT KEYS the group holds, or null when it does not exist; `venue.members` the
 *   account keys whose device is routed in the venue
 * @returns {string[]} owed steps, each `<what>:<detail>`, in the order they must be taken
 */
export function fixturesOwed(seen, spec = CAMPAIGN_FIXTURES) {
  const owed = [];
  for (const a of spec.accounts) if (!seen.accounts[a]) owed.push(`account:${a}`);
  if (!seen.dm) owed.push(`dm:${spec.dm.join('-')}`);
  if (!seen.venue.community || !seen.venue.publicSalon) owed.push('venue:community');
  if (!seen.venue.privateSalon) owed.push(`venue:${spec.privateSalon}`);
  const inVenue = seen.venue.members ?? [];
  for (const m of spec.venueMembers ?? []) if (!inVenue.includes(m)) owed.push(`venue-member:${m}`);
  for (const g of spec.groups) {
    const held = seen.groups[g.name];
    if (held === null || held === undefined) owed.push(`group:${g.name}`);
    for (const m of g.members) if (!held || !held.includes(m)) owed.push(`member:${g.name}:${m}`);
  }
  return owed;
}
