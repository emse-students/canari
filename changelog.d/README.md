# changelog.d - one file per unreleased change

**A pull request never edits `CHANGELOG.md`. It adds ONE file here**, named after what it does
(`changelog.d/minesweeper-generation-speed.md`, any unique name ending in `.md`), holding exactly
the entry it would have written under `## [Unreleased]`:

```md
### Fixed - what changed, in one line

A sentence or two, and a LINK to the wiki page carrying the reasoning ([page](docs/wiki/page.md)).
```

**Why a file and not a line.** Every entry used to be inserted directly below `## [Unreleased]`,
so any two pull requests open at once edited the same line and conflicted, which blocks the
automatic merge. `CHANGELOG.md merge=union` did not help: GitHub ignores `.gitattributes` merge
drivers when it merges a pull request. A file per entry means there is no shared line left to
conflict on. It also removes the rebase trap `docsMergeArtefacts.test.ts` describes, where an entry
ended up under a version that was cut before it existed.

**What folds them in.** The bump of a STABLE release (`scripts/bump-app-version.sh`,
`promote_changelog`) writes every fragment under the new `## [X.Y.Z] - DATE` heading, in file-name
order, and deletes them in the same commit. A pre-release leaves them here for the stable that
follows. `docsMergeArtefacts.test.ts` fails a pull request that writes under `[Unreleased]` directly,
or adds a fragment that does not start with a `### ` heading.

This README is the only file here the bump does not fold in.
