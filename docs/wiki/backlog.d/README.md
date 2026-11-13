# backlog.d - one file per backlog entry, each naming its version

**The backlog IS this directory**: one file per entry, and every entry names the version it is
planned for. [plan](../plan.md) lists them by version, generated from those lines. Since 2026-11-13
`backlog.md` holds no entry - only the rules and the list of what is owed to the user.

```md
## P1 - what is wrong, or what is owed, in one line

target: 1.8.0

What is known, so that picking it up does not start with a rediscovery, and a LINK to the wiki page
carrying the mechanism ([cicd](../cicd.md)).
```

- **The name**: kebab-case, after what the entry is, ending in `.md`
  (`p1-new-member-receives-the-past.md`).
- **The title**: one `## ` heading on the first line, and no second one; `### ` sub-headings are fine.
- **The target**: the first non-blank line after the title is `target: <version>`, one of `TIERS` in
  [`tools/backlog-plan/plan.mjs`](../../../tools/backlog-plan/plan.mjs) - the one place the allowed set
  is written. Every target is a real version number (owner, 2026-11-13): no `later`, no `1.7.x`.
- **A reading**: an entry owed a measurement and nothing else (on a phone, on dev, on production, on
  the rig, in a browser) opens its title with `Reading owed - `, says what is built and the reading
  that closes it, and targets the EARLIEST version. The plan lists the readings as one checklist
  under [Readings owed](../plan.md#readings-owed).
- **Links are relative to this directory** (`../cicd.md`, `../../../CHANGELOG.md`) - the file is read
  where it is, nothing moves it.

## The workflow

**Adding an entry is planning it, in the same pull request.** Write the file with its `target:`,
then run `bun tools/backlog-plan/plan.mjs` and commit `docs/wiki/plan.md` with it. Pick the version by
the order the plan states: P1 first, then the oldest; a reading always in the earliest version; a
version that is already full takes the entry in the next one.

**Replanning is changing one line.** Edit `target:`, regenerate, commit; no file ever moves. Say why in
the [roadmap log](../roadmap.md#log-of-replannings-and-milestones) when it is more than one entry.

**When a version ships, the plan is re-read whole**: the shipped version leaves `TIERS`, every entry
still naming it is replanned (the readings to the new earliest version), and the log says so.

**Closing an entry.** Delete its file when it ships, and regenerate the plan: the rule goes to
`durable-rules.md`, the story to `changelog.d/`, the mechanism to the wiki page. An entry whose object
has disappeared (feature removed, superseded) is deleted too, with the evidence written in the closing
commit or its changelog fragment. Fix every link to it - `wiki-links.test.mjs` names them.

**A conflict on `docs/wiki/plan.md`** is resolved by regenerating it, never by hand: take either side,
run the script, commit. The page carries no count for that reason - a count is a line every pull
request adding an entry would edit.

## The tests

- `.github/scripts/tests/backlog-fragments.test.mjs` refuses a fragment that is not exactly one entry,
  and a heading in `backlog.md` other than the frozen one
  (`.github/scripts/tests/backlog-legacy-headings.txt`, which only ever loses lines).
- `.github/scripts/tests/backlog-plan.test.mjs` refuses a fragment with no target or an unknown one, a
  reading planned after the earliest version, and a `plan.md` that is not what the targets produce.
- `.github/scripts/tests/backlog-closed.test.mjs` refuses a title that announces its own closure.

**Why a file and not a section.** 47 of the 130 commits on `main` between 2026-10-27 and 2026-10-30
touched `backlog.md`, and two pull requests adding an entry at the same place conflict - which stops
the automatic merge until somebody rebases. `changelog.d/` solved the same problem for
`CHANGELOG.md` ([cicd](../cicd.md)).
