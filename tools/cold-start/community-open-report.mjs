/**
 * READS `community-open.mjs`'s `runs.ndjson` AND SAYS WHAT EACH OPEN WAITED ON.
 *
 *   bun tools/cold-start/community-open-report.mjs <dir>/runs.ndjson [--chain <label> <run>]
 *
 * Per label (one condition): the milestones (median / worst, ms from the tap that asked for them)
 * and the CRITICAL CHAIN of the cold hub and the first salon open, each link read from the app's
 * own first-party calls (the `window.fetch` record the run keeps) and its console:
 *
 *   session   `[A] refresh✓` - the access token, which every call waits for
 *   mlsReady  `[INIT] MLS ready` - `isLoggedIn` flips here, and the community listing starts after it
 *   listing   `GET /api/channels/workspaces/user/me` - the rail is drawn from its answer
 *   keyGroup  `GET .../distribution-group` then `GET .../members` - awaited per community BEFORE
 *   salons    `GET /api/channels/workspace/<id>/user/me` - the salon rows are drawn from its answer
 *   history   `GET /api/channels/<id>/messages?limit=200` - the salon's messages, fetched on open
 *
 * `--chain <label> <run>` prints one run's whole timeline instead (calls, long tasks, gaps, marks,
 * the console lines that name a phase) - the reading behind a number.
 */
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
const rows = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  // Rows written before 2026-10-14 17:55 carry one copy of each long task PER warm re-arm (one
  // observer per arm); a task is its start and duration, so the copies collapse.
  .map((r) => ({ ...r, longTasks: [...new Map(r.longTasks.map((t) => [t.join(':'), t])).values()] }));

const MARKS = ['nav', 'tapHub', 'rail', 'salons', 'tapTarget', 'targetSalons', 'tapSalon', 'pane', 'messages', 'tapOther', 'otherSalons', 'tapOtherSalon', 'otherPane', 'tapReopen', 'reopenPane', 'reopenMessages'];
const PHASES = /refresh✓|MLS ready|WORKSPACE-LOAD|GRAINE\] community|UNREAD|CHANNEL\]|RESTORE|checkpoint|HISTORY|LANDING|AvatarCache|Initialising MLS|Local database|PIN\]|TransportFailure|WS\] Connected/;
const short = (path) => path.replace(/[0-9a-f]{8}-?[0-9a-f-]{20,}/g, '<id>').slice(0, 72);

if (rest[0] === '--chain') {
  const r = rows.filter((x) => x.label === rest[1])[Number(rest[2]) - 1];
  const ev = [];
  for (const k of MARKS) if (r[k] != null) ev.push([r[k], `==== ${k}`]);
  for (const [path, start, end, bytes, method] of r.api)
    ev.push([start, `API ${method} ${short(path)} -> ${end == null ? 'pending' : `${end} (+${end - start} ms)`} ${bytes}B`]);
  for (const [s, d] of r.longTasks) ev.push([s, `LONGTASK ${d} ms`]);
  for (const [s, g] of r.gaps) ev.push([s, `GAP ${g} ms`]);
  for (const [t, , text] of r.console) if (PHASES.test(text)) ev.push([t, `log ${text.replace(/^\[[\d:.]+\] /, '').slice(0, 150)}`]);
  ev.sort((a, b) => a[0] - b[0]);
  for (const [t, s] of ev) console.log(String(t).padStart(6), s);
  process.exit(0);
}

const first = (r, re) => r.api.find(([path]) => re.test(path));
const logAt = (r, re) => r.console.find(([, , text]) => re.test(text))?.[0] ?? null;
const d = (a, b) => (a == null || b == null ? null : a - b);
/** Main-thread time lost to long tasks that STARTED between two marks. */
const sumTasks = (r, from, to) =>
  from == null || to == null ? null : r.longTasks.filter(([t]) => t >= from && t <= to).reduce((x, [, dur]) => x + dur, 0);

/** One run's milestones and chain links, each a duration in ms. */
function measure(r) {
  const listing = first(r, /^\/api\/channels\/workspaces\/user\/me/);
  const history = r.api.find(([path, start]) => /^\/api\/channels\/[^/]+\/messages\?limit=200/.test(path) && start >= (r.tapSalon ?? Infinity) && start <= (r.messages ?? Infinity));
  const keyGroup = r.api.filter(([path, start]) => /distribution-group|\/members$/.test(path) && listing && start >= listing[2] && start < (r.salons ?? Infinity));
  const salonsCall = r.api.find(([path, start]) => /^\/api\/channels\/workspace\/[^/]+\/user\/me/.test(path) && listing && start >= listing[1]);
  const session = logAt(r, /refresh✓/);
  const mlsReady = logAt(r, /\[INIT\] MLS ready/);
  return {
    'click>rail': d(r.rail, r.clickHub),
    'click>salon msgs': d(r.messages, r.clickSalon),
    'click>reopen msgs': d(r.reopenMessages, r.clickReopen),
    'tap>rail': d(r.rail, r.tapHub),
    'tap>salons': d(r.salons, r.tapHub),
    'tap>target salons': d(r.targetSalons, r.tapHub),
    'salon>pane': d(r.pane, r.tapSalon),
    'salon>msgs': d(r.messages, r.tapSalon),
    'switch>salons': d(r.otherSalons, r.tapOther),
    'switch salon>pane': d(r.otherPane, r.tapOtherSalon),
    'reopen>msgs': d(r.reopenMessages, r.tapReopen),
    'longtask ms, hub open': sumTasks(r, r.tapHub, r.targetSalons),
    'longtask ms, salon open': sumTasks(r, r.tapSalon, r.messages),
    'longtask ms, cached reopen': sumTasks(r, r.tapReopen, r.reopenMessages),
    // The chain, on the page's own axis (ms after timeOrigin) or as a link's own duration.
    'session at': session,
    'mlsReady at': mlsReady,
    'listing sent at': listing?.[1] ?? null,
    'listing rtt': listing ? d(listing[2], listing[1]) : null,
    'rail after listing': listing ? d(r.rail, listing[2]) : null,
    'key group links ms': keyGroup.length ? Math.max(...keyGroup.map(([, , e]) => e)) - Math.min(...keyGroup.map(([, s]) => s)) : null,
    'salons call rtt': salonsCall ? d(salonsCall[2], salonsCall[1]) : null,
    'history sent after tap': history ? d(history[1], r.tapSalon) : null,
    'history rtt': history ? d(history[2], history[1]) : null,
    'history head': history?.[5] != null ? d(history[5], history[1]) : null,
    'history body read': history?.[5] != null ? d(history[2], history[5]) : null,
    'history kB': history ? Math.round(Number(history[3]) / 1024) : null,
    'decode+render after history': history ? d(r.messages, history[2]) : null,
  };
}

const labels = [...new Set(rows.map((r) => r.label))];
for (const label of labels) {
  const runs = rows.filter((r) => r.label === label);
  const measured = runs.map(measure);
  const table = Object.keys(measured[0]).map((metric) => {
    const vals = measured.map((m) => m[metric]);
    const ok = vals.filter((v) => v != null).sort((a, b) => a - b);
    return {
      metric,
      median: ok.length ? ok[Math.floor((ok.length - 1) / 2)] : '-',
      worst: ok.length ? (vals.includes(null) && /^(tap|salon|switch|reopen)/.test(metric) ? 'TIMEOUT' : ok.at(-1)) : '-',
      n: ok.length,
    };
  });
  console.log(`\n${label} (${runs.length} runs)`);
  console.table(table);
}
