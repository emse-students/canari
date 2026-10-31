/**
 * ON DEV, A DESTRUCTIVE GESTURE TOUCHES ONLY WHAT THE CAMPAIGN CREATED - pinned (R5, 2026-10-24).
 *
 * `campaign-ledger.mjs` decides, from the per-estate ledger, whether a group, community, salon or
 * device may be destroyed, and which of a sweep's candidates `--only <ids> --expect N` lets it take.
 * Dev is shared with testers, so every refusal here is a tester's conversation left alone. Pure: no
 * file, estate or browser is touched.
 *
 *   bun archive/campaign-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMPAIGN_FIXTURES,
  CampaignOwnershipError,
  fixturesOwed,
  ledgerLine,
  mayDestroy,
  ownerOf,
  parseLedger,
  planSweep,
  sweepArgs,
} from '../campaign-ledger.mjs';

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

const AT = '2026-10-24T00:00:00.000Z';
const text = [
  ledgerLine({ kind: 'group', name: 'GRP3-abc', by: 'grp3' }, AT),
  ledgerLine({ kind: 'group', id: 'g-fixture', name: 'campaign-g2', by: 'campaign-fixtures' }, AT),
  ledgerLine({ kind: 'community', id: 'w-venue', name: 'Venue', by: 'campaign-fixtures' }, AT),
  ledgerLine({ kind: 'salon', name: 'general', parent: 'Venue', by: 'createChannel' }, AT),
  ledgerLine({ kind: 'device', id: 'web-1111-2222', by: 'newdevice' }, AT),
  '{not json',
].join('\n');
const { entries, unreadable } = parseLedger(text);

// ── the ledger ──────────────────────────────────────────────────────────────────────────────────
ok('five records read', entries.length === 5);
ok('an unreadable line is REPORTED by number, never skipped in silence', unreadable.join() === '6');
ok('an unknown kind is refused at write', throws(() => ledgerLine({ kind: 'channel', name: 'x' }, AT)) !== null);
ok('a record with neither name nor id is refused', throws(() => ledgerLine({ kind: 'group' }, AT)) !== null);
ok('a salon without its community is refused', throws(() => ledgerLine({ kind: 'salon', name: 'general' }, AT)) !== null);

// ── ownership ───────────────────────────────────────────────────────────────────────────────────
ok('a runner group recorded by name is owned by that name', !!ownerOf(entries, { kind: 'group', name: 'GRP3-abc' }));
ok('...and by its id later, when the record holds no id (name decides)', !!ownerOf(entries, { kind: 'group', name: 'GRP3-abc', id: 'g-later' }));
ok('a fixture recorded WITH an id is matched by id', !!ownerOf(entries, { kind: 'group', id: 'g-fixture', name: 'renamed' }));
ok('a different id under a recorded name is NOT owned (an id decides when both have one)', !ownerOf(entries, { kind: 'group', id: 'g-other', name: 'campaign-g2' }));
ok('a kind mismatch is not owned', !ownerOf(entries, { kind: 'community', name: 'GRP3-abc' }));
ok('a salon is owned only in ITS community', !!ownerOf(entries, { kind: 'salon', name: 'general', parent: 'Venue' }) && !ownerOf(entries, { kind: 'salon', name: 'general', parent: 'A tester community' }));
ok('a device is owned by its full id', !!ownerOf(entries, { kind: 'device', id: 'web-1111-2222' }));
ok('a device PREFIX is not ownership', !ownerOf(entries, { kind: 'device', id: 'web-1111' }));

// ── the per-estate rule ─────────────────────────────────────────────────────────────────────────
const tester = { kind: 'group', name: 'Projet de Camille' };
ok('dev: a group the campaign did not create is REFUSED', !mayDestroy({ estate: 'dev', entries, target: tester }).ok);
ok('dev: the refusal says why (testers share dev)', /not in the campaign ledger/.test(mayDestroy({ estate: 'dev', entries, target: tester }).reason));
ok('dev: a minted name NOT in the ledger is refused too - a shape is not ownership there', !mayDestroy({ estate: 'dev', entries, target: { kind: 'group', name: 'GRP9-zzz' } }).ok);
ok('dev: a campaign group may be destroyed', mayDestroy({ estate: 'dev', entries, target: { kind: 'group', name: 'GRP3-abc' } }).ok);
ok('dev: an empty ledger allows nothing', !mayDestroy({ estate: 'dev', entries: [], target: { kind: 'group', name: 'GRP3-abc' } }).ok);
ok('local: the rig owns the estate, the name allowlists decide', mayDestroy({ estate: 'local', entries: [], target: tester }).ok);
for (const estate of ['production', 'prod', '', undefined]) {
  ok(`${String(estate)}: refused whatever the ledger says`, !mayDestroy({ estate, entries, target: { kind: 'group', name: 'GRP3-abc' } }).ok);
}
ok('the guard error is typed, carrying its target', new CampaignOwnershipError('x', tester).target === tester);

// ── a sweep: --only <ids> --expect N ────────────────────────────────────────────────────────────
const cands = [
  { kind: 'group', id: 'g1', name: 'GRP3-abc' },
  { kind: 'group', id: 'g2', name: 'GRP9-zzz' },
];
ok('dev: no --only refuses the whole sweep', !planSweep({ estate: 'dev', entries, candidates: cands }).ok);
ok('dev: --only without --expect refuses', !planSweep({ estate: 'dev', entries, candidates: cands, only: ['g1'] }).ok);
ok('dev: --expect that differs from the ids named refuses', !planSweep({ estate: 'dev', entries, candidates: cands, only: ['g1'], expect: 2 }).ok);
const one = planSweep({ estate: 'dev', entries, candidates: cands, only: ['g1'], expect: 1 });
ok('dev: one owned id named and expected -> exactly that one is taken', one.ok && one.targets.map((t) => t.id).join() === 'g1');
ok('dev: the candidate not named is LEFT and listed', one.left.map((t) => t.id).join() === 'g2');
const notOwned = planSweep({ estate: 'dev', entries, candidates: cands, only: ['g1', 'g2'], expect: 2 });
ok('dev: naming a candidate the campaign does not own refuses EVERYTHING (nothing partial)', !notOwned.ok && notOwned.targets.length === 0);
ok('dev: an id that is no longer a candidate refuses (the estate moved)', !planSweep({ estate: 'dev', entries, candidates: cands, only: ['g7'], expect: 1 }).ok);
ok('local: no flags -> every candidate, as before R5', planSweep({ estate: 'local', entries: [], candidates: cands }).targets.length === 2);
ok('local: with --only the count still binds', !planSweep({ estate: 'local', entries: [], candidates: cands, only: ['g1'], expect: 2 }).ok);
ok('production: refused', !planSweep({ estate: 'production', entries, candidates: cands, only: ['g1'], expect: 1 }).ok);
const args = sweepArgs(['--only', 'a, b,', '--expect', '2']);
ok('--only/--expect parse', args.only.join() === 'a,b' && args.expect === 2);
ok('absent flags parse to null', sweepArgs([]).only === null && sweepArgs([]).expect === null);

// ── the fixtures ────────────────────────────────────────────────────────────────────────────────
const none = { accounts: {}, dm: false, venue: { community: false, publicSalon: false, privateSalon: false }, groups: {} };
const all = fixturesOwed(none);
ok('an empty estate owes the four accounts first', all.slice(0, 4).join() === 'account:owner,account:peer,account:third,account:fourth');
ok('...then the DM, the venue, its private salon and the three groups', ['dm:owner-peer', 'venue:community', 'venue:campaign-private', 'group:campaign-g2', 'group:campaign-g4', 'group:campaign-big'].every((x) => all.includes(x)));
const built = {
  accounts: { owner: true, peer: true, third: true, fourth: true },
  dm: true,
  venue: { community: true, publicSalon: true, privateSalon: true, members: ['owner', 'peer', 'third', 'fourth'] },
  groups: { 'campaign-g2': ['owner', 'peer'], 'campaign-g4': ['owner', 'peer', 'third', 'fourth'], 'campaign-big': ['owner', 'peer', 'third', 'fourth'] },
};
ok('a built estate owes nothing (idempotent)', fixturesOwed(built).length === 0);
ok('a group missing one member owes exactly that member', fixturesOwed({ ...built, groups: { ...built.groups, 'campaign-g4': ['owner', 'peer', 'third'] } }).join() === 'member:campaign-g4:fourth');
ok('a venue missing the third and fourth owes exactly them', fixturesOwed({ ...built, venue: { ...built.venue, members: ['owner', 'peer'] } }).join() === 'venue-member:third,venue-member:fourth');
ok('every account but the owner is owed a venue seat', CAMPAIGN_FIXTURES.venueMembers.join() === 'peer,third,fourth');
ok('the plan names exactly four accounts and three groups', CAMPAIGN_FIXTURES.accounts.length === 4 && CAMPAIGN_FIXTURES.groups.length === 3);

// ── every destructive primitive calls the guard (a static read; nothing is imported) ────────────
const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const GUARDED = {
  'groupnav.mjs': ['deleteGroup'],
  'comm.mjs': ['openCommunitySettings', 'openChannelSettings'],
  'arm.mjs': ['expireInvite'],
  'purge-devices.mjs': [null],
  'archive/del1.mjs': [null],
  // Moved out of `archive/grp.mjs` (2026-10-24) so the 1.4.1 race rows remove through the same guard.
  'archive/addmember.mjs': ['removeMember', 'leaveGroup'],
};
for (const [file, fns] of Object.entries(GUARDED)) {
  const src = readFileSync(join(HERE, file), 'utf8');
  for (const fn of fns) {
    const body = fn === null ? src : src.slice(src.search(new RegExp(`function ${fn}\\(`)), src.search(new RegExp(`function ${fn}\\(`)) + 1500);
    ok(`${file}${fn ? ` ${fn}` : ''} calls assertCampaignOwned`, /assertCampaignOwned\(/.test(body));
  }
}
for (const [file, fn] of [
  ['groupnav.mjs', 'createGroup'],
  ['groupnav.mjs', 'createDM'],
  ['comm.mjs', 'createCommunity'],
  ['comm.mjs', 'createChannel'],
]) {
  const src = readFileSync(join(HERE, file), 'utf8');
  const at = src.search(new RegExp(`export async function ${fn}\\(`));
  const next = src.indexOf('\nexport ', at + 10);
  ok(`${file} ${fn} records what it created`, /recordCreated\(/.test(src.slice(at, next === -1 ? undefined : next)));
}

console.log(failures ? `[campaign] ${failures} FAILURE(S)` : '[campaign] clean - on dev only the ledger may be destroyed, by id and count');
process.exit(failures ? 1 : 0);
