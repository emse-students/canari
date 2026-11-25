/**
 * THE PLAN BY VERSION, GENERATED FROM THE `target:` LINE OF EVERY BACKLOG ENTRY.
 *
 * WHY THIS EXISTS. The owner, 2026-11-13: *"Ce serait bien d'organiser TOUTES les entrees du backlog
 * selon un plan sur 1.7.0, les mineures, et 1.8.0 etc. Histoire d'avoir vraiment un plan pour la
 * suite."* A hand-kept plan is the roadmap's annexes again: 590 rows copied out of the entries, stale
 * the day after (its release train still forecast engagement packages two releases after they
 * shipped). So the version an entry is planned for lives IN the entry, as one line under its title -
 * `target: 1.8.0` - and this page is derived from those lines. Replanning is changing one line; no
 * file ever moves.
 *
 * WHAT A FRAGMENT MUST CARRY. `docs/wiki/backlog.d/<name>.md` opens with its `## ` title, and the
 * first non-blank line after it is `target: <version>`, one of `TIERS` below - the ONE place the
 * allowed set is written. Every tier is a real version number (owner, 2026-11-13: no `later`, no
 * `x`): an entry nobody will do is deleted with its evidence, not parked in a tier with no number.
 *
 * READINGS ARE A CHECKLIST OF THE EARLIEST TIER. An entry whose title opens with `Reading owed - `
 * is owed a measurement and nothing else (on a phone, on dev or on production). The owner,
 * 2026-11-13: *"au plus tot, marre de trainer ca"* - so a reading may only target the EARLIEST tier,
 * and the page lists them under one `### Readings owed` heading, an anchor that therefore never
 * moves while readings exist.
 *
 * THE ORDER INSIDE A TIER. P1 first, then the entries with no severity (the chantiers, decisions and
 * questions the owner placed in the tier), then P2, then P3; inside a group the OLDEST first (the
 * owner's order of 2026-11-11), the age being the earliest `YYYY-MM-DD` in the title, else the first
 * one in the body; the file name breaks ties.
 *
 * THE PAGE IS GENERATED WHERE IT IS READ, AND NEVER COMMITTED (2026-11-21). It was committed from
 * 2026-11-13, and nearly every pull request touches an entry, so every merge to `main` left the
 * other open pull requests CONFLICTING on it and their automatic merge stalled until somebody
 * merged `main` by hand. The order above makes the collision certain: a new entry is the youngest
 * of its group, so two pull requests filing one each insert at the SAME line (15 pairs out of 15
 * conflicted). No order lifts it - two insertions between the same neighbours always conflict, so
 * a re-sorted page only moves the collisions. So `docs/wiki/plan.md` is gitignored, the git hooks
 * (`.husky/post-checkout`, `post-merge`, and the commit tier of `local-ci.sh`) rewrite it, and
 * `wiki-links.test.mjs` resolves the links into it from `render()`. The reasoning and the
 * measurement: docs/wiki/cicd.md, "The plan page is generated where it is read".
 *
 * Usage:
 *   bun tools/backlog-plan/plan.mjs            # write docs/wiki/plan.md (gitignored)
 *   bun tools/backlog-plan/plan.mjs --check    # exit 1 if a target is missing or unknown; writes nothing
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The allowed targets, in version order, earliest first. A shipped tier is removed from the head; a
 * new one is INSERTED where its version falls (1.8.1 between 1.8.0 and 1.9.0), its opening logged in
 * roadmap.md.
 */
export const TIERS = ['1.8.1', '1.8.2', '1.9.0', '1.10.0'];

/** The title prefix that makes an entry a reading - owed a measurement and nothing else. */
export const READING_PREFIX = 'Reading owed - ';

const VERSION = /^\d+\.\d+\.\d+$/;
const GROUPS = [
  { key: 'P1', label: 'P1 - security, or a user-facing path that is broken' },
  { key: '-', label: 'Chantiers, decisions and questions (no severity)' },
  { key: 'P2', label: 'P2 - correctness' },
  { key: 'P3', label: 'P3 - hygiene' },
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Reads every fragment of `backlog.d/` into what the plan needs. Never throws on a bad fragment:
 * the problem is returned, so `--check` and the CI test can name every one at once.
 * @param {string} root the repository root
 * @returns {{ entries: Array<{file: string, title: string, target: string|null, severity: string, date: string, reading: boolean}>, problems: string[] }}
 */
export function collect(root = ROOT) {
  const dir = join(root, 'docs', 'wiki', 'backlog.d');
  const entries = [];
  const problems = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').replace(/\r/g, '').split('\n');
    const title = (lines[0] ?? '').replace(/^## +/, '').trim();
    const next = lines.slice(1).find((l) => l.trim() !== '') ?? '';
    const m = /^target: (\S+)$/.exec(next.trim());
    let target = m ? m[1] : null;
    if (!m) {
      problems.push(`${file}: the first line after the title must be 'target: <version>' (one of ${TIERS.join(', ')})`);
    } else if (!TIERS.includes(target) || !VERSION.test(target)) {
      problems.push(`${file}: 'target: ${target}' is not a planned version (${TIERS.join(', ')})`);
      target = null;
    }
    const reading = title.startsWith(READING_PREFIX);
    if (reading && target && target !== TIERS[0]) {
      problems.push(`${file}: a reading targets the earliest version, ${TIERS[0]}, not ${target}`);
    }
    const sev = /^P([123])\b/.exec(title);
    const date =
      /\d{4}-\d{2}-\d{2}/.exec(title)?.[0] ?? /\d{4}-\d{2}-\d{2}/.exec(lines.slice(1).join('\n'))?.[0] ?? '9999-99-99';
    entries.push({ file, title, target, severity: sev ? `P${sev[1]}` : '-', date, reading });
  }
  for (const t of TIERS) if (!VERSION.test(t)) problems.push(`TIERS holds '${t}', which is not a version number`);
  return { entries, problems };
}

/** A title as a link label: inner links flattened to their label, brackets escaped. */
function label(title) {
  return title.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/([[\]])/g, '\\$1');
}

const byAge = (a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file);

/**
 * The page, from the entries. Pure: the same fragments always give the same bytes.
 * @param {ReturnType<typeof collect>['entries']} entries
 * @param {string} [stamp] the provenance line (see `provenance`); empty in the tests, which compare entries only
 */
export function render(entries, stamp = '') {
  const out = [
    '# Plan - every open backlog entry, by version',
    '',
    ...(stamp ? [`<!-- ${stamp} -->`, ''] : []),
    '<!-- GENERATED by tools/backlog-plan/plan.mjs from the `target:` line of each docs/wiki/backlog.d/ file, and gitignored. Do not edit: change that line; the git hooks rewrite this page after every checkout, merge and commit, and `bun tools/backlog-plan/plan.mjs` does it by hand. -->',
    '',
    '**This page is generated, in your checkout, and never committed.** Each entry of [the backlog](backlog.d/README.md)',
    'names the version it is planned for in one line under its title (`target: 1.8.0`); this page lists',
    'them by version. To replan, change that line - `make test-ci-scripts` fails while an entry has no',
    'target or an unknown one. Versions are named, not dated',
    '(owner, 2026-11-13: *"les dates ne sont qu\'une estimation, en vrai on fait le plus vite',
    'possible"*). The hypotheses, the dated commitments and the log of every replanning are on the',
    '[roadmap](roadmap.md).',
    '',
    `Order inside a version: P1, then the entries with no severity, then P2, then P3; the oldest first`,
    'inside each group. The readings - an entry owed a measurement and nothing else - all sit in the',
    `earliest version, as a checklist.`,
    '',
  ];
  for (const tier of TIERS) {
    const mine = entries.filter((e) => e.target === tier);
    out.push(`## ${tier}`, '');
    const work = mine.filter((e) => !e.reading);
    if (!work.length) out.push('_No entry planned beyond its readings._', '');
    for (const g of GROUPS) {
      const rows = work.filter((e) => e.severity === g.key).sort(byAge);
      if (!rows.length) continue;
      out.push(`**${g.label}**`, '');
      for (const e of rows) out.push(`- [${label(e.title)}](backlog.d/${e.file})`);
      out.push('');
    }
    const readings = mine.filter((e) => e.reading).sort(byAge);
    if (readings.length) {
      out.push('### Readings owed', '');
      for (const e of readings) out.push(`- [ ] [${label(e.title.slice(READING_PREFIX.length))}](backlog.d/${e.file})`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

const STAMP = /^<!-- generated from commit (\w+)/m;

/**
 * Which commit the page was written from, and whether the backlog tree differed from it, so a page
 * that a hook-less git operation (`rebase --abort`, `reset --hard`, `stash pop`, `cherry-pick`,
 * `restore`) left behind says it is stale instead of looking current.
 * @returns {{ head: string, dirty: boolean }}
 */
export function provenance(root = ROOT) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  return { head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'docs/wiki/backlog.d', 'docs/wiki/backlog.md').length > 0 };
}

/** Where the page lives. */
export const PAGE = (root = ROOT) => join(root, 'docs', 'wiki', 'plan.md');

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const { entries, problems } = collect(ROOT);
  if (check) {
    for (const p of problems) console.error(`FAIL ${p}`);
    if (problems.length) process.exit(1);
    const page = PAGE();
    if (existsSync(page)) {
      const had = STAMP.exec(readFileSync(page, 'utf8'))?.[1];
      const { head } = provenance();
      if (had !== head) console.error(`WARN page generated from ${had ? had.slice(0, 9) : 'an unknown commit'}, HEAD is ${head.slice(0, 9)}: run bun tools/backlog-plan/plan.mjs`);
    } else console.error('WARN docs/wiki/plan.md is missing: run bun tools/backlog-plan/plan.mjs');
    console.log(`ok   every one of ${entries.length} entries targets a planned version`);
  } else {
    for (const p of problems) console.error(`WARN ${p}`);
    const { head, dirty } = provenance();
    writeFileSync(PAGE(), render(entries, `generated from commit ${head}${dirty ? ' + uncommitted backlog.d changes' : ''}; stale if HEAD differs: rerun bun tools/backlog-plan/plan.mjs`));
    console.log(`wrote docs/wiki/plan.md - ${entries.length} entries${problems.length ? `, ${problems.length} problem(s)` : ''}`);
  }
}
