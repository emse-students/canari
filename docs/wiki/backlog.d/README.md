# backlog.d - one file per backlog entry

**A pull request never adds an entry to `docs/wiki/backlog.md`. It adds ONE file here**, named
after what the entry is (`docs/wiki/backlog.d/p1-new-member-receives-the-past.md`, kebab-case,
ending in `.md`), holding exactly the entry it would have written there:

```md
## P1 - what is wrong, or what is owed, in one line

What is known, so that picking it up does not start with a rediscovery, and a LINK to the wiki page
carrying the mechanism ([cicd](../cicd.md)).
```

One `## ` title per file; `### ` sub-headings are fine. **Links are relative to this directory**
(`../cicd.md`, `../../../CHANGELOG.md`) - the file is read where it is, nothing moves it.

**The backlog is `backlog.md` AND this directory, read together.** `backlog.md` holds the entries
written before 2026-10-30 and its header (the rules every entry follows: nothing parked, severity,
nothing fixed). Nothing folds the fragments back into it: a fold would recreate the one shared file
and conflict with every open pull request editing a fragment.

**Linking an entry.** `CLAUDE.md`'s queue links `docs/wiki/backlog.d/<file>.md` the way it links an
anchor of `backlog.md`.

**Changing an entry.** A fragment: edit its file. A legacy entry in `backlog.md`: edit it in place
for a line or two; for anything larger, or to retitle it, MOVE it here (delete it from `backlog.md`,
create its file) - a retitled heading in `backlog.md` is refused, because a new heading there is
what this directory exists to stop.

**Closing an entry.** Delete its file when it ships, exactly as a `backlog.md` entry is deleted:
the rule goes to `durable-rules.md`, the story to `changelog.d/`, the mechanism to the wiki page.

**Why a file and not a section.** 47 of the 130 commits on `main` between 2026-10-27 and 2026-10-30
touched `backlog.md`, and two pull requests adding an entry at the same place conflict - which stops
the automatic merge until somebody rebases. `changelog.d/` solved the same problem for
`CHANGELOG.md` ([cicd](../cicd.md)). `.github/scripts/tests/backlog-fragments.test.mjs` refuses a
fragment that is not exactly one entry, and a heading in `backlog.md` that it did not carry on
2026-10-30 (the frozen list, `.github/scripts/tests/backlog-legacy-headings.txt`, only ever loses
lines); `backlog-closed.test.mjs` refuses a closed entry here as it does there.
