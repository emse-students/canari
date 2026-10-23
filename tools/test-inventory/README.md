# `test-inventory` - every test suite of the repository, measured, with its deletion candidates

```sh
bun tools/test-inventory/inventory.mjs                        # JSON to tools/test-inventory/out/inventory.json
bun tools/test-inventory/inventory.mjs --timings vitest.json  # + runtime and real case counts
bun tools/test-inventory/inventory.mjs --ci-red 60            # + the failing CI runs' logs
bun tools/test-inventory/inventory.mjs --write-wiki           # regenerate the section of the wiki
bun tools/test-inventory/lib.test.mjs                         # the tool's own readings, pinned on strings
```

It is the first step of WP-TEST-TOOLING-REFORM
([test-suite-reform](../../docs/wiki/test-suite-reform.md)), asked for by the user on 2026-10-18
(*"un nombre de test aberrant"*). It **deletes nothing and changes no test**: a candidate is a pointer
for a reviewer with the covering test named, never a verdict. The generated section of that page
("Inventory, 2026-10-19") is this tool's output, so a number there is reproduced by the command, not
remembered.

## What it lists

Every tracked test file of: the frontend vitest suite, the four NestJS services' jest specs, the Rust
crates (`frontend/mls-core`, `frontend/src-tauri`, `apps/chat-gateway`, `apps/call-service`), the
Android Kotlin unit tests, `.github/scripts/tests`, the harness self-tests, the `tools/*` tests and
the `tools/ecosystem-shape` gate. `inventory.mjs` holds the suite list (one predicate per suite) - a
new suite is one line there.

| Column | How it is derived | What it cannot know |
| --- | --- | --- |
| `cases` | a regex over the file: `it(` / `test(` at the start of a line, `#[test]`, `@Test` | an `it.each` counts once (`dynamicCases` says how many such declarations); a script test has `assertions`, not cases. Give it a runner report (`--timings`) and `runCases` is the runner's own number |
| `purpose` | the top docblock's first sentence, else the first `describe` names, else the first case titles; `unknown` when none exists | the sentence is the author's claim, not a check of it. `purposeSource` says which of the three it came from |
| `ms` | `endTime - startTime` per file in a vitest or jest `--json` report | files run in parallel, so the sum is a cost ranking and not the job's wall clock; absent without `--timings` |
| `lastFixTouch` | the newest commit of the window (`--window-days`, default 90) that touches the file AND whose subject says fix, revert, regression or flake. A commit touching more than 25 test files is ignored | **evidence that something was wrong near the test, not proof it was red.** A fix commit routinely adds or edits a test without that test ever failing |
| `born`, `bornInFix` | the commit that first added the file; `bornInFix` when its subject is a fix | a test born in a fix was written for a defect that really happened - the strongest reason to keep it, and the one a reviewer should check first |
| `ciRed` | with `--ci-red N`, the last N failed `ci.yml` runs' `--log-failed` output, scanned for a failing line naming a test file (cached under the OS temp dir, one file per run, so a rerun costs no API calls) | a run that fails in a build or an audit names no test; a run with a shared cause (an import broken for everyone) names dozens. `meta.ciRed.biggestRun` says so |
| `textReads` | whether the file reads a file of the tree as text, and the kind by the extensions on the lines that build the path: `app-source`, `native-contract`, `docs-ci` | a heuristic over path literals; WP-T5 read the 86 files by hand and its verdicts win |

## The deletion candidates

Only classes a static reading can justify. Each names the covering test, or says there is none.

| Class | The signal | Covering test named |
| --- | --- | --- |
| `declared-copy` | the test is a member of a group in `.github/scripts/lib/declared-duplicates.mjs` - copies the repository keeps byte-identical on purpose, pinned by `declared-duplicates.test.mjs` - and does not read what is installed beside it | the group's first member, plus the gate. `high` when the subject source is itself pinned identical |
| `source-text` | reads app source as text, imports no app code, no sibling test shares its stem, and it is not on WP-T5's keep list (named in the wiki section, or a `dir/*` family it keeps whole) | the sibling when one exists; otherwise `none-found`, which means "a human reads it", never "delete" |
| `duplicate-body` | a case body identical (whitespace, comments aside) to a case in another file of the same area | the other file |
| `same-titles` | two files of one directory share at least 3 case titles, and at least half of the smaller file | the sibling |
| `constant-mirror` | at least 60 % of the cases only compare a name to a literal | none: a change detector |
| `no-assertion`, `skipped`, `empty`, `snapshot-only` | a case with no `expect`/`assert`; `it.skip`/`todo`; a file with no case; every assertion a snapshot | none |
| `per-service-copy` | the same case bodies in services that are NOT declared copies (information only) | - |

**Not a candidate, deliberately:** `framework-boot.spec.ts` exists four times and is identical, but each
copy asserts what is installed in ITS service's `node_modules`, so the tool skips any copy that reads
its own install. Nor is a copy whose group in `declared-duplicates.mjs` carries `keepEachCopy`
(`http-error-log.spec.ts` builds its input with the `axios` each service resolves for itself); the
other declared spec copies were deleted on 2026-10-21 ([test-suite-reform](../../docs/wiki/test-suite-reform.md#72-the-declared-copies-deleted-2026-10-21)). A test that reads a native file (`native-contract`) is out of scope: no other layer
catches it short of a device build (WP-T5).

## Rules for changing it

- It reads; it never writes except its JSON (`out/`, git-ignored) and, with `--write-wiki`, the region of
  `test-suite-reform.md` between `<!-- test-inventory:begin -->` and `<!-- test-inventory:end -->`.
- A new reading gets a case in `lib.test.mjs` on the string shape that broke it. `make test-ci-scripts`
  runs that file.
- The numbers move with every merge. Regenerate rather than edit, and say which commit the section
  describes (the generated line does).
