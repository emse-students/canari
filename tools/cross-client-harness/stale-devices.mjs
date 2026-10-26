/**
 * PURGES THE BROWSER DEVICES THE RIG MINTED AND ABANDONED - part of the campaign preflight.
 *
 *   bun stale-devices.mjs                    read only: the plan, per account, and its count
 *   bun stale-devices.mjs --purge --expect N  purge exactly the N devices the plan names
 *
 * WHY (1.4.1-alpha.5, 2026-10-26). Every DEV row mints a browser device for the owner account and
 * leaves it enrolled. The peer's client then vouches for each of them in every row that commits in a
 * group the owner is in - seven `[PENDING] ... already in tree ... vouching` lines per ADM row, which
 * made four rows PASS-DIRTY on rig debris. The bar is `PASS`, so the debris goes at its source rather
 * than being narrated away; `FRESH_DEVICE_SESSION_NARRATION` stays for the rows that mint on purpose.
 *
 * WHAT MAY GO is decided by `planStaleDevices` (`device-census.mjs`), an ALLOWLIST: a browser device
 * of one of the rig's accounts, that no live seat holds (each web seat's page is asked for its own
 * device id, and an unreadable web seat refuses the plan), and that the campaign ledger records
 * creating. The purge itself is `purge-devices.mjs`, the product's own device panel, driven from the
 * account's first web seat - so the server's own revocation path does the deleting, and that tool's
 * ledger check (`assertCampaignOwned`) and `--expect` apply a second time.
 *
 * `--expect N` IS THE COUNT A HUMAN READ ON THE DRY RUN. A plan that changed shape in between is
 * refused whole, as `cleanup.mjs` refuses a sweep: the decision was taken against a different fleet.
 */
import { spawnSync } from 'node:child_process';
import { subjectFor } from './accounts.mjs';
import { ESTATE, ledger } from './campaign.mjs';
import { APP_TAB, client, evaluate } from './chat.mjs';
import { planStaleDevices } from './device-census.mjs';
import { census } from './devices.mjs';
import { ACCOUNT_OF, PORTS } from './names.mjs';
import { HARNESS_ROOT, requireScript } from './scriptpath.mjs';

const argv = process.argv.slice(2);
const purge = argv.includes('--purge');
const expectArg = argv.includes('--expect') ? Number(argv[argv.indexOf('--expect') + 1]) : null;
const log = (s) => console.log(`[stale-devices] ${s}`);

if (ESTATE !== 'dev' && ESTATE !== 'local') throw new Error(`[stale-devices] estate ${ESTATE} is refused - dev and local only`);

/** The device id a seat's page holds for `userId`, or null when the seat does not answer. */
async function seatDevice(port, userId) {
  try {
    const cx = await client(port, APP_TAB, { focus: false });
    try {
      return (await evaluate(cx, `localStorage.getItem(${JSON.stringify(`mls_device_id_${userId}`)}) || ''`)) || null;
    } finally {
      cx.close();
    }
  } catch (e) {
    log(`${port}: unreadable (${e.message.split('\n')[0]})`);
    return null;
  }
}

const accounts = [...new Set(Object.values(ACCOUNT_OF))];
const userOf = Object.fromEntries(accounts.map((k) => [k, subjectFor(k)]));

// EVERY SEAT IS ASKED, phones included: a phone is never `web-`, but its id in `live` costs nothing.
// Only a WEB seat that does not answer refuses the plan - I1 and A2 are routinely absent.
const live = [];
const unread = [];
for (const [seat, key] of Object.entries(ACCOUNT_OF)) {
  if (!PORTS[seat]) continue;
  const id = await seatDevice(PORTS[seat], userOf[key]);
  if (id) live.push(id);
  else if (seat.startsWith('W')) unread.push(seat);
}

const owned = ledger()
  .filter((e) => e.kind === 'device')
  .map((e) => e.id);
const plan = planStaleDevices({ rows: census(new Date().toISOString().slice(0, 10)), users: Object.values(userOf), live, owned, unread });
if (!plan.ok) throw new Error(`[stale-devices] REFUSED - ${plan.refusal}`);

const keyOf = Object.fromEntries(accounts.map((k) => [userOf[k], k]));
for (const k of plan.kept) log(`kept   ${keyOf[k.userId]} ${k.deviceId.slice(-14)} - ${k.why}`);
for (const t of plan.targets) log(`STALE  ${keyOf[t.userId]} ${t.deviceId.slice(-14)}`);
log(`${plan.targets.length} stale browser device(s) on ${ESTATE}`);

if (!purge) {
  log(plan.targets.length ? `read only - purge them with --purge --expect ${plan.targets.length}` : 'nothing to purge');
  process.exit(0);
}
if (expectArg === null || expectArg !== plan.targets.length) {
  throw new Error(`[stale-devices] REFUSED - --expect ${expectArg} but the plan names ${plan.targets.length}: look again`);
}

/** Runs `purge-devices.mjs` and returns its closing JSON report. */
function purgeDevices(args) {
  const r = spawnSync(process.execPath, [requireScript('purge-devices.mjs'), ...args], { cwd: HARNESS_ROOT, encoding: 'utf8' });
  const out = r.stdout ?? '';
  const at = out.lastIndexOf('\n{');
  if (r.status !== 0 || at === -1) throw new Error(`[stale-devices] purge-devices ${args.join(' ')} exited ${r.status}:\n${out}${r.stderr ?? ''}`);
  return JSON.parse(out.slice(at + 1));
}

let failed = 0;
for (const key of accounts) {
  const ids = plan.targets.filter((t) => t.userId === userOf[key]).map((t) => t.deviceId);
  if (!ids.length) continue;
  // The account's FIRST web seat drives its panel (W1 for the owner, W2 for the peer...).
  const seat = Object.keys(ACCOUNT_OF).find((s) => ACCOUNT_OF[s] === key && s.startsWith('W') && PORTS[s]);
  const port = String(PORTS[seat]);
  const dry = purgeDevices(['--only', ids.join(','), '--port', port, '--dry']);
  if (dry.namedButAbsent.length) throw new Error(`[stale-devices] REFUSED - ${seat}'s panel does not list ${dry.namedButAbsent.length} planned device(s)`);
  const done = purgeDevices(['--only', ids.join(','), '--port', port, '--expect', String(dry.deletableBefore)]);
  log(`${key} from ${seat}: ${done.deleted}/${ids.length} purged, ${done.failures.length} failure(s)`);
  if (done.deleted !== ids.length) failed += ids.length - done.deleted;
}
log(failed ? `${failed} device(s) NOT purged` : `${plan.targets.length} purged`);
process.exit(failed ? 1 : 0);
