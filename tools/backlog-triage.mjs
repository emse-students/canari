#!/usr/bin/env bun
/**
 * THE BACKLOG'S TRIAGE, AS A COMMAND INSTEAD OF A RE-READING.
 *
 * `docs/wiki/backlog.md` had grown to ~3 500 lines and 118 sections, and the only way to know what
 * was buildable now, what waited on the user, and what was already fixed was to read all of it.
 * The first triage (2026-10-26) took one full read; the result is a tag line under each entry:
 *
 *     Triage 2026-10-26: mechanical (PR #2509)
 *
 * and this tool reads those lines back, so the next triage starts from a count and a list rather
 * than from the top of the file.
 *
 * THE TAGS (a closed set, because a tag nobody can predict is a tag nobody filters on):
 *   mechanical    still open, small and safe to build now (or a read-only measurement an agent can take)
 *   design        still open and needs a design or a decision about shape before code
 *   owed-to-user  waits on the user: a decision, a floor (`minClientVersion`), a secret, a click, a look
 *   hardware      waits on a reading on a real phone or a live estate; there is nothing left to build
 *   post-stable   decided to start after the current stable, or held until then
 *   note          a decision log or an accepted limit: nothing owed, kept so nobody re-derives it
 * An entry that is FIXED has no tag: it is deleted, its rule goes to durable-rules, its story to the
 * changelog fragment, its mechanism to the wiki page it pointed at.
 *
 * WHAT IS AN ENTRY. A level-2 heading, or a level-3 heading directly under a level-2 heading that has
 * tagged level-3 children (the umbrella sections: "Open defects", "Payments", ...). Other level-3
 * headings are parts of an entry and are never tagged. A heading containing "tracked privately" is
 * exempt on purpose: its substance is outside this repository.
 *
 * WHY THE COMMITTED INDEX CARRIES COUNTS AND NO LINKS. A link per entry would break the wiki-links
 * gate every time an entry is deleted (deleting a shipped entry is the file's own first rule), and
 * every pull request touching a heading would conflict on a generated list. Counts change on one
 * line per tag. The anchors are one command away: `--list <tag>`.
 *
 * Usage (bun only):
 *   bun tools/backlog-triage.mjs                   counts per tag, and any untagged entry
 *   bun tools/backlog-triage.mjs --list [tag]      one line per entry: tag, severity, anchor, title
 *   bun tools/backlog-triage.mjs --write           regenerate the index block at the top of backlog.md
 *   bun tools/backlog-triage.mjs --check           exit 1 on a malformed tag line, an untagged entry
 *                                                  or an index block that is stale
 * The pull request gate runs `tools/backlog-triage.test.mjs`, which asserts only that the file's tag
 * lines are well formed; freshness (`--check`) belongs to the triage session, not to every PR.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The closed tag set, in the order the index lists it. */
export const TAGS = ["mechanical", "design", "owed-to-user", "hardware", "post-stable", "note"];

export const INDEX_START = "<!-- triage-index:start -->";
export const INDEX_END = "<!-- triage-index:end -->";

const TAG_LINE = /^Triage (\d{4}-\d{2}-\d{2}): ([a-z-]+)(?: \((.+)\))?\s*$/;
const EXEMPT = /tracked privately/i;

/** GitHub's heading slug (the one `wiki-links.test.mjs` also implements). */
export function slug(heading) {
  return heading
    .trim()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replaceAll(" ", "-");
}

/**
 * Reads every heading outside code fences and the tag line directly under it (one blank line may
 * sit between). Returns the headings in file order with `tag`, `date`, `note`, `anchor`, `badTag`.
 */
export function parseHeadings(text) {
  const lines = text.split("\n");
  const headings = [];
  const seen = new Map();
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("```")) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6}) +(.*)$/.exec(lines[i]);
    if (!m) continue;
    const title = m[2].trim();
    const base = slug(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const h = {
      line: i + 1,
      level: m[1].length,
      title,
      anchor: n === 0 ? base : `${base}-${n}`,
      tag: null,
      date: null,
      note: null,
      badTag: null,
    };
    let j = i + 1;
    if (lines[j] === "") j++;
    const t = j < lines.length ? TAG_LINE.exec(lines[j]) : null;
    if (t) {
      h.date = t[1];
      h.note = t[3] ?? null;
      if (TAGS.includes(t[2])) h.tag = t[2];
      else h.badTag = t[2];
    } else if (j < lines.length && /^Triage \d/.test(lines[j])) {
      h.badTag = lines[j];
    }
    headings.push(h);
  }
  return headings;
}

/** The entries of the file: tagged headings, plus the level-2 headings that are untagged and standalone. */
export function entriesOf(headings) {
  const tagged = headings.filter((h) => h.tag);
  const entries = tagged.map((h) => ({ ...h, severity: /^(P[123])\b/.exec(h.title)?.[1] ?? "-" }));
  const untagged = [];
  for (let k = 0; k < headings.length; k++) {
    const h = headings[k];
    if (h.level !== 2 || h.tag || h.badTag || EXEMPT.test(h.title)) continue;
    let hasTaggedChild = false;
    for (let c = k + 1; c < headings.length && headings[c].level > 2; c++) {
      if (headings[c].tag) hasTaggedChild = true;
    }
    if (!hasTaggedChild && !/^(Backlog|Index by triage tag)$/.test(h.title)) untagged.push(h);
  }
  return { entries, untagged };
}

/** Counts per tag, in TAGS order. */
export function countsOf(entries) {
  return TAGS.map((tag) => ({ tag, n: entries.filter((e) => e.tag === tag).length }));
}

/** The committed block: counts, the legend, and the commands. No per-entry links (see the header). */
export function renderIndex(entries, untagged, date) {
  const counts = countsOf(entries);
  const meaning = {
    mechanical: "open, small, safe to build or to measure now",
    design: "open, needs a design or a decision about shape first",
    "owed-to-user": "waits on the user: a decision, a floor, a secret, a click, a look",
    hardware: "waits on a reading on a phone or a live estate",
    "post-stable": "decided to start after the current stable, or held until then",
    note: "a decision log or an accepted limit, nothing owed",
  };
  const rows = counts.map((c) => `| \`${c.tag}\` | ${c.n} | ${meaning[c.tag]} |`);
  return [
    INDEX_START,
    `**Index by triage tag** (${entries.length} tagged entries, triaged ${date}; \`bun tools/backlog-triage.mjs --list <tag>\` lists them with anchors, \`--write\` regenerates this block).`,
    "",
    "| Tag | Entries | Means |",
    "| --- | --- | --- |",
    ...rows,
    "",
    untagged.length
      ? `Untagged since the last triage: ${untagged.length} (\`bun tools/backlog-triage.mjs\` names them).`
      : "Every entry carries a tag. A fixed entry has none: it is deleted outright.",
    INDEX_END,
  ].join("\n");
}

/** Replaces the index block, or inserts it before the first horizontal rule when none exists yet. */
export function applyIndex(text, block) {
  const a = text.indexOf(INDEX_START);
  const b = text.indexOf(INDEX_END);
  if (a !== -1 && b !== -1 && b > a)
    return text.slice(0, a) + block + text.slice(b + INDEX_END.length);
  const rule = text.indexOf("\n---\n");
  if (rule === -1) throw new Error("no horizontal rule to insert the index before");
  return `${text.slice(0, rule)}\n${block}\n${text.slice(rule)}`;
}

/** The tag line's date of the newest triage found (the block's stated date). */
export function newestDate(headings) {
  return (
    headings
      .map((h) => h.date)
      .filter(Boolean)
      .sort()
      .at(-1) ?? "never"
  );
}

/** Problems a gate can assert: unknown tags, malformed tag lines. */
export function problemsOf(headings) {
  return headings
    .filter((h) => h.badTag)
    .map(
      (h) =>
        `line ${h.line}: "${h.title.slice(0, 60)}" has a malformed or unknown tag line (${h.badTag})`,
    );
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const file = join(root, "docs", "wiki", "backlog.md");
  const text = readFileSync(file, "utf8");
  const headings = parseHeadings(text);
  const { entries, untagged } = entriesOf(headings);
  const args = process.argv.slice(2);
  const date = newestDate(headings);
  const block = renderIndex(entries, untagged, date);

  if (args.includes("--write")) {
    writeFileSync(file, applyIndex(text, block));
    process.stdout.write(`index written: ${entries.length} tagged, ${untagged.length} untagged\n`);
    return;
  }
  if (args.includes("--list")) {
    const want = args[args.indexOf("--list") + 1];
    const filter = want && !want.startsWith("--") ? want : null;
    if (filter && !TAGS.includes(filter)) {
      process.stderr.write(`unknown tag "${filter}"; known: ${TAGS.join(", ")}\n`);
      process.exit(2);
    }
    for (const e of entries.filter((x) => !filter || x.tag === filter)) {
      process.stdout.write(
        `${e.tag}\t${e.severity}\t#${e.anchor}\t${e.title}${e.note ? `  [${e.note}]` : ""}\n`,
      );
    }
    return;
  }
  if (args.includes("--check")) {
    const problems = problemsOf(headings);
    for (const u of untagged)
      problems.push(`line ${u.line}: "${u.title.slice(0, 60)}" is untagged`);
    if (!text.includes(block))
      problems.push("the index block is stale: run `bun tools/backlog-triage.mjs --write`");
    for (const p of problems) process.stderr.write(`${p}\n`);
    process.exit(problems.length ? 1 : 0);
  }
  for (const c of countsOf(entries)) process.stdout.write(`${String(c.n).padStart(4)}  ${c.tag}\n`);
  process.stdout.write(
    `${String(entries.length).padStart(4)}  tagged in all, newest triage ${date}\n`,
  );
  for (const u of untagged) process.stdout.write(`UNTAGGED line ${u.line}: ${u.title}\n`);
  for (const p of problemsOf(headings)) process.stdout.write(`MALFORMED ${p}\n`);
}

if (import.meta.main) main();
