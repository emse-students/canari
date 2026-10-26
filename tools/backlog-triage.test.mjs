#!/usr/bin/env bun
/**
 * Self-test of `tools/backlog-triage.mjs`: the parser on fixtures, the index round trip, and the one
 * assertion that is cheap enough to run on every pull request - the real backlog's tag lines are
 * well formed (a closed tag set, a date, directly under a heading). Freshness of the committed index
 * is NOT asserted here: it would make every pull request that deletes a shipped entry (the file's own
 * first rule) regenerate a block and conflict with its neighbours. `--check` is the triage session's.
 *
 * Usage: bun tools/backlog-triage.test.mjs   (no arguments, no network)
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  INDEX_END,
  INDEX_START,
  TAGS,
  applyIndex,
  countsOf,
  entriesOf,
  newestDate,
  parseHeadings,
  problemsOf,
  renderIndex,
  slug,
} from "./backlog-triage.mjs";

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}\n`,
  );
};

const FIXTURE = [
  "# Backlog",
  "",
  "intro",
  "",
  "---",
  "",
  "## P2 - A tagged entry (2026-10-25)",
  "",
  "Triage 2026-10-26: mechanical (PR #1)",
  "",
  "body",
  "",
  "### Not an entry, a part of one",
  "",
  "text",
  "",
  "## An umbrella",
  "",
  "### P3 - first child",
  "",
  "Triage 2026-10-26: hardware",
  "",
  "### P3 - second child",
  "Triage 2026-10-26: note (accepted)",
  "",
  "## An untagged standalone entry",
  "",
  "body",
  "",
  "## Something tracked privately (2026-10-25)",
  "",
  "body",
  "",
  "```",
  "## inside a fence, not a heading",
  "```",
  "",
  "## P3 - A bad tag",
  "",
  "Triage 2026-10-26: urgent",
  "",
].join("\n");

const heads = parseHeadings(FIXTURE);
const { entries, untagged } = entriesOf(heads);
eq(
  "tagged entries, in file order",
  entries.map((e) => `${e.tag}:${e.severity}`),
  ["mechanical:P2", "hardware:P3", "note:P3"],
);
eq("the PR note is kept", entries[0].note, "PR #1");
eq("a tag line directly under a heading (no blank) parses", entries[2].tag, "note");
eq(
  "a part of an entry is not an entry",
  heads.find((h) => h.title.startsWith("Not an entry")).tag,
  null,
);
eq(
  "only the standalone untagged level-2 heading is flagged",
  untagged.map((h) => h.title),
  ["An untagged standalone entry"],
);
eq(
  '"tracked privately" is exempt and a fence hides its lines',
  heads.some((h) => h.title.startsWith("inside a fence")),
  false,
);
eq("an unknown tag is reported, not counted", problemsOf(heads).length, 1);
eq(
  "counts follow the closed tag set",
  countsOf(entries).map((c) => c.n),
  [1, 0, 0, 1, 0, 1],
);
eq("newest triage date", newestDate(heads), "2026-10-26");
eq(
  "anchors follow GitHub and suffix repeats",
  [slug("P2 - A tagged entry (2026-10-25)"), slug("A `b` [c](d) e")],
  ["p2---a-tagged-entry-2026-10-25", "a-b-c-e"],
);

const twice = parseHeadings("## Same\n\n## Same\n");
eq(
  "a repeated heading gets the -1 suffix",
  twice.map((h) => h.anchor),
  ["same", "same-1"],
);

const block = renderIndex(entries, untagged, "2026-10-26");
const once = applyIndex(FIXTURE, block);
eq(
  "the block is inserted before the first rule",
  once.indexOf(INDEX_START) < once.indexOf("\n---\n"),
  true,
);
eq("applying twice changes nothing", applyIndex(once, block), once);
eq(
  "the end marker follows the start marker",
  once.indexOf(INDEX_END) > once.indexOf(INDEX_START),
  true,
);
eq(
  "untagged entries are named in the block",
  block.includes("Untagged since the last triage: 1"),
  true,
);

// The real file: every tag line is well formed. Anything else is the triage session's business.
const root = resolve(import.meta.dirname, "..");
const real = parseHeadings(readFileSync(join(root, "docs", "wiki", "backlog.md"), "utf8"));
eq("the real backlog has no malformed tag line", problemsOf(real), []);
eq(
  "the real backlog is triaged at all",
  real.some((h) => h.tag),
  true,
);
eq(
  "every real tag is in the closed set",
  real.filter((h) => h.tag).every((h) => TAGS.includes(h.tag)),
  true,
);

if (failed) {
  process.stdout.write(`${failed} failed\n`);
  process.exit(1);
}
process.stdout.write("all ok\n");
