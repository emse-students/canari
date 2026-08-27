# The five projects, and where they diverge

**Measured 2026-08-19, from the code, in all five repositories.** Nothing on this page is recalled;
every row was read out of a file, and the file is named. Re-measure before acting on any of it - a
repository that was aligned in August is not evidence about a repository in November.

## What this page is, and what it is not

The five share an ecosystem, a school, a set of users and - increasingly - a set of solved problems.
They do **not** share code, and this page is not a proposal to make them. The question it answers is
narrower and comes first:

> For each problem that more than one of them has solved, **what did each one actually do?**

Only after that is "one contract, five implementations" a decision rather than a preference. A
shared package has a cost nobody has paid yet (five build pipelines, five deploys, one version), and
[the head](frontend/seo.md#the-same-method-in-the-three-sibling-repos-all-shipped-and-verified-on-prod-2026-08-19)
is the worked example on the other side: one method, four repositories, written down four times,
nothing shared, and it works.

| Repo | Where | Stack |
| --- | --- | --- |
| **Canari** | this monorepo | SvelteKit SPA + NestJS/Axum services, Postgres |
| **Sky** | `../Sky` | SvelteKit SSR (`adapter-node`), SQLite |
| **MiGallery** | `../MiGallery` | SvelteKit SSR (`adapter-node`), SQLite + Immich |
| **Portail-etu** | `../refonte-portail-etu` | SvelteKit SSR (`svelte-adapter-bun`), no database |
| **Le Cercle** | `../le-cercle` | SvelteKit SSR, SQLite (`bun:sqlite`) |

All five are SvelteKit + Paraglide. That is what makes the divergences below comparable, and what
makes each of them a choice rather than a consequence of the stack.

---

## 1. Tolerant name search - SIX boxes, FOUR implementations, TWO with no tolerance at all

The user's standing requirement is that **every search box across the ecosystem tolerates typos and
word inversion and ranks by closeness**. Six boxes were found; two did none of it.

**Closed 2026-08-19.** The promise, the tolerance ladder and the roster measurement that chose its
numbers are written down once, in [search-contract](search-contract.md), and all four TypeScript
implementations now meet it with a test that pins it. **What follows is the MEASUREMENT that
produced the contract, not current state** - read the contract page for what each repo does today.

| Repo | Where | Method, as FOUND on 2026-08-19 | Typos | Inversion | Ranked |
| --- | --- | --- | --- | --- | --- |
| **Canari** | `apps/core-service/src/users/userSearch.ts:50` | Postgres `word_similarity` (pg_trgm) + `unaccent`, per term, `search_score` column | trigram overlap | yes (per-term `AND`) | yes |
| **Sky** | `src/lib/utils/format.ts:150` `personMatchScore` | in-memory, token-to-token, **plain Levenshtein**, tolerance 1 (<=4 chars) / 2 | yes | yes | yes |
| **MiGallery** | `src/lib/fuzzy.ts` `fuzzyScore` | in-memory, token-to-token, **Damerau-Levenshtein (OSA)**, same tolerance ladder | yes | yes | yes |
| **Portail-etu** | `src/routes/associations/+page.svelte:18` | `name.toLowerCase().includes(query)` | **no** | **no** | **no** |
| **Le Cercle** | `src/lib/search/fuzzy.ts` `fuzzyScore` | in-memory, token-to-token, **Damerau-Levenshtein (OSA)**, four tiers (exact / prefix / contains / fuzzy) weighted 0.85 quality + 0.15 coverage; HIGHER is better | yes | yes | yes |

**Le Cercle's row was rewritten on 2026-08-19 and is the most interesting fact on this page.**
It was measured that morning as a SQL `LIKE '%q%'` ordered by promotion - no typos, no inversion, no
ranking, in front of an operator with a queue behind them. By that afternoon it was not: commit
`87b8d30` had replaced it with a full matcher, applied to three surfaces rather than one (the till,
the roster, and the bartenders dialog, which had no search at all). **A third independent
implementation of the same contract, written by somebody who had not read this page.** That is the
strongest argument here for writing the CONTRACT down and letting each repo implement it - it is
what keeps happening on its own.

The rest, as found, and what each one turned into:

- **Portail-etu's association filter** was plain substring over name and description, the only box
  left with no tolerance at all. It is now `src/lib/search/fuzzy.ts`, ranked rather than filtered,
  with the description matched by substring ONLY - a paragraph long enough contains a word within
  one edit of almost any query, so a tolerance over prose is a match on everything.
- **Sky and MiGallery were the same algorithm one metric apart.** Both did token-to-token matching
  with a tolerance of 1 for tokens of 4 characters or fewer and 2 above; MiGallery counted a
  transposition as ONE edit and Sky as two, so `jaen` found `Jean` in the gallery and nowhere else.
  Sky is on OSA now - except in `nameDistance`, which answers "is this the same person, for a merge
  that cannot be undone" rather than "did they mistype", and deliberately stays strict.
- **Three TypeScript implementations, two tolerance ladders.** Sky and MiGallery allowed 1 edit up
  to 4 characters and 2 above; Le Cercle allowed 0 up to 3, 1 up to 6, and 2 above, taken from the
  SHORTER of the two tokens. Nobody could say which the ecosystem promised. **That was settled by
  measuring, not by choosing** - the loose ladder put a wrong person in the list on half of all
  queries and recovered no typo the tight one did not, which is the whole of
  [search-contract](search-contract.md#why-those-numbers).

**Canari's is a different kind of thing, not a better or worse one.** Trigram similarity in the
database scales to a table nobody wants to load into memory, and it is the only one of the five that
does not require the candidate set to be in the client. It cannot be "aligned" with the other two
without changing what it is; what CAN be aligned is the promise - typos, inversion, ranking - and
Canari keeps it.

**The convergence unit here is the CONTRACT, not the code** - and it is now written: a tolerance
ladder chosen by measurement, the "every query token must match something" rule, and a total
ordering. Four implementations, one shared page, no shared package, and a fifth medium (Canari's
trigram search) held to the promise rather than to the number.

## 2. The deadline on an outbound call - FOUR values, ONE repo with none

`fetch` has no default timeout. An upstream that accepts the connection and then says nothing holds
the request, and the page behind it, for as long as it likes - there is no error to catch in that
state and no fallback to reach.

| Repo | Constant | Value | Scope |
| --- | --- | --- | --- |
| **Canari** | `apps/chat-delivery-service/src/utils/url-guard.ts:208` `OUTBOUND_BUDGET_MS` | 4000 | link previews; the same file's other callers use ad-hoc `4_000`, `5_000` and `10_000` |
| **Sky** | `src/lib/server/outbound.ts:18` `OUTBOUND_BUDGET_MS` | 4000 | every server-to-server call, by convention stated in the file |
| **Portail-etu** | `src/lib/outbound.ts:22` `OUTBOUND_BUDGET_MS` | 4000 | every remote call, "one constant rather than one per call site, because a budget that differs by caller is a budget nobody can state" |
| **Le Cercle** | `src/lib/server/migallery/index.ts:14` `TIMEOUT_MS` | 4000 | that module only; `src/lib/server/canari/memberships.ts:40` uses a bare `5000` |
| **MiGallery** | - | **none** | no server-side `fetch` carries a signal; the only `signal:` uses are browser-side user cancellation |

The number is already unanimous where it is stated at all: **4 seconds**, three times, independently.
The divergence is not the value, it is whether there is one constant to point at.

**MiGallery is the gap that matters.** It is the one of the five whose server does the most outbound
work - every page proxies Immich - and it is the one with no deadline anywhere. This is not a style
difference; it is the failure the other three wrote a file to prevent.

## 3. The locale, under SSR - THREE repos carry the bug Portail-etu just fixed

Paraglide's `getLocale()` skips the `localStorage` and `preferredLanguage` strategies whenever
`isServer` (`src/lib/paraglide/runtime.js`, the `!isServer` guards in
`resolveLocaleWithStrategies`). Under SSR the locale is therefore resolved twice - once by the
server, once by the hydrating client - and **Svelte claims the server's text nodes rather than
comparing them**.

| Repo | `strategy` in `vite.config.ts` | Server can evaluate | Client can evaluate |
| --- | --- | --- | --- |
| **Sky** | `["cookie", "preferredLanguage", "baseLocale"]` | cookie, baseLocale | cookie, **preferredLanguage**, baseLocale |
| **MiGallery** | `['cookie', 'preferredLanguage', 'baseLocale']` | cookie, baseLocale | cookie, **preferredLanguage**, baseLocale |
| **Le Cercle** | `['cookie', 'preferredLanguage', 'baseLocale']` | cookie, baseLocale | cookie, **preferredLanguage**, baseLocale |
| **Portail-etu** | `["cookie", "baseLocale"]` | cookie, baseLocale | cookie, baseLocale |
| **Canari** | n/a - SPA, the locale is a purely client-side question | | |

The divergent case is narrow and real: **a visitor with no `PARAGLIDE_LOCALE` cookie whose browser
prefers a non-base locale.** The server renders French and stamps `<html lang="fr">`; the client
resolves English. Portail-etu dropped `preferredLanguage` for exactly this reason, paying automatic
`Accept-Language` detection to get an answer both sides give identically.

**What is NOT yet measured, and decides whether this is a defect or only an inconsistency:** whether
Svelte 5 patches a text node during hydration when it disagrees with the server's. If it does, the
cost is a flash; if it does not, an English-preferring visitor sits on French text until their first
client-side navigation. **Measure it before changing three repositories** - one browser with an
English `Accept-Language` against `sky.mitv.fr` settles it. Do not port the Portail-etu fix on the
strength of this page alone.

## 4. The public head - FOUR aligned, ONE not applicable

Shipped and verified on production on 2026-08-19. The method, what each head is FOR, and the two
rules that only came out of doing all of them are on [frontend/seo.md](frontend/seo.md).

This is the axis to reason from when deciding what convergence should look like: four repositories,
one method, `serializeJsonLd` and the absolute-URL-from-the-request-origin rule duplicated verbatim
in each, nothing shared, four independent deploys. It cost four small files and four wiki pages, and
no repository can break another.

Le Cercle is the exception and correctly so: `static/robots.txt` is `Disallow: /`, the app is a till
and a ledger behind an account, and its head is a title and a description. Nothing to share.

## 5. Typed errors at the throw - the rule is Canari's, and it has not travelled

**Never branch on an error MESSAGE**: a distinction carried in prose is one exactly one call site
will make. Classify at the throw, as a type.

| Repo | Typed error classes |
| --- | --- |
| **Canari** | 17 - `BackupError`, `SessionExpiredError`, `ChannelApiError`, `MediaPurgedError`, `UpstreamUnreachableError`, the five `Graine*` ones, `DeviceRevokedError`, `StalledRequestError`, ... |
| **Portail-etu** | 1 - `CanariApiError` (`status: number \| null`; `null` means no answer at all, which is what separates a 404 from a timeout) |
| **Sky** | 1 - `RelationError` |
| **MiGallery** | 0 |
| **Le Cercle** | 0 |

Zero is not automatically wrong - a repository with no branch that depends on WHY something failed
owes nothing. It is worth checking rather than assuming: the Portail-etu case (both detail loaders
answering 404 for any upstream failure, which under SSR tells a crawler to deindex a page that
exists) was invisible until the type existed to make the distinction.

## 6. The gates, and whether anything runs them

| Repo | Formatter | `format:check` in CI | Tests in CI | CI at all |
| --- | --- | --- | --- | --- |
| **Canari** | oxfmt + oxlint | yes (`.github/workflows/ci.yml`) | yes | yes |
| **Sky** | prettier | **yes, since 2026-08-19** | yes | yes |
| **Portail-etu** | prettier | yes (`test.yml`, `deploy.yml`) + pre-push hook | yes | yes |
| **MiGallery** | prettier | **yes, since 2026-08-19** (`ci.yml`) | yes | yes |
| **Le Cercle** | prettier (inside `lint`) | via `lint` | via the pipeline | yes - and **verified running**: 10 pipelines, the last 7 green (2026-08-19) |

Both findings this section carried have closed, one of them before it was written:

- **Le Cercle's CI was measured as inert and was not.** `.gitlab-ci.yml` was gated on a
  `CERCLE_CI_ENABLED` variable somebody had to set; `db2a530`, on 2026-08-18, deleted that kill
  switch and left the pipeline running on the default branch, merge requests and tags. Two documents
  in that repository still said otherwise until 2026-08-19 and were the source of this row - **a
  claim about a gate, read out of prose rather than out of the file that defines it.** That a runner
  actually picks the pipelines up was then verified, and is written up below.
- **MiGallery's formatting was enforced only by a hook.** Sky had been in exactly that state and
  three files had drifted out of shape with no red run to show for it. `ci.yml` runs `format:check`
  there now.

### Proving a pipeline runs, without the API that would have said so

The GitLab project is private, `/api/v4/projects/.../pipelines` answers `404 Project Not Found`
without a token, and no token exists on this machine. That closed the obvious route and nothing
else, because **a pipeline that runs leaves evidence in two places nobody thinks of as a CI
interface**, and both were reachable with the access already in hand:

- **The repository itself.** GitLab writes `refs/environments/<name>/deployments/<n>` into the
  project's ref namespace when a deployment job runs. `git ls-remote origin` over the SSH remote -
  no token, no API - listed seven of them, and resolving each SHA named the commit it deployed. The
  highest, `deployments/12`, is the tip of `main`. (`refs/pipelines/*` is hidden by the server and
  returned nothing; that absence is a property of `transfer.hideRefs`, not a fact about pipelines,
  which is exactly the distinction a full `ls-remote` settled.)
- **The host, because the runner is the host.** `cercle-prod` is a SHELL runner on the production
  box, reachable as `ssh cercle`. `journalctl -u gitlab-runner` carries one line per job with its
  pipeline id and outcome: **28 jobs across 10 pipelines, 25 succeeded**. The three failures are
  `22096`-`22098`, all between 19:17 and 19:42 on 2026-08-18 - the bring-up hour, when the reserved
  `image:` job name and the `docker login` against a registry that does not exist were being found.
  Every pipeline from `22099` onwards is 3/3 green, including `22104` and `22105` today.
- **And the end state agrees with both.** The running container is `le-cercle:6f7f2d22…`, the tip of
  `main`, up and healthy; `https://cercle.canari-emse.fr/api/health` answers
  `{"status":"ok","schema":13}`. Since `deploy` is the last stage and the job fails unless that
  health check returns 200, a container running that tag is a passed `gates` and a passed
  `build:image` behind it.

**The lesson is the one this page keeps re-learning in a new costume.** "Blocked on project access"
was, again, a claim read off the one interface that happened to be closed. The question was never
"can I call the pipelines endpoint" - it was "did anything run" - and three independent witnesses to
that were open the whole time. **Enumerate what a mechanism WRITES before concluding you cannot
observe it**; a CI system that deploys leaves refs in a repository, lines in a journal and a process
on a host, and any one of them answers.

## 7. Line endings

`.gitattributes` pinning the working tree to LF: **all five, as of 2026-08-19** (Canari and Le Cercle
already had one; Sky, MiGallery and Portail-etu were given one that day).

Without it, a checkout on Windows (`core.autocrlf=true`) materialises CRLF while prettier - which
has no `endOfLine` override in any of these repos, so it defaults to `lf` - insists on LF. The
result is a repository whose own `format:check` cannot pass on Windows and passes on Linux: **a gate
that reports the operating system rather than the code.** Sky's did exactly that, and Portail-etu's
did it the moment its pre-push hook was reached: 82 files failed, none of them touched by anyone.
The blobs were already LF in every case, so the fix changes no committed content - it changes what a
checkout writes to disk.

## 8. The package manager, and the version four repos never declared

Every one of the five runs bun, and until 2026-08-27 **not one of them said which bun**. No
`engines`, no `packageManager`, no `.bun-version`. Whatever the machine happened to have was the
toolchain, and nothing anywhere would notice if two machines disagreed.

That is not a tidiness complaint. It took Portail-etu's production down for hours on 2026-08-26,
and the shape of the failure is the lesson:

- The deploy host is a KVM guest whose CPU advertises no AVX2, and bun's runtime cannot start there
  from **1.3.9** onward. A CD run bisected it on the box itself - 1.3.14 through 1.3.9 all hang,
  1.3.8 reaches user code.
- **Every check that looked at bun still passed.** `bun --version` answers instantly, because the
  binary loads. `bun install` succeeds. `bun run build` succeeds *too* - `bun run` honours a bin's
  node shebang, so Vite was quietly running under Node the whole time. Only the server itself,
  launched by pm2 as `bun ./build/index.js`, spun at 100% CPU inside its module load, before its
  first log line and before it bound a port.

So a deploy step that installed 1.4.0 over the box's working 1.3.7 was green at every stage and
served nothing. **A version string proves a binary loads; only user code running proves a runtime
works.** Portail-etu's install step now runs a one-line `bun -e` that writes a marker file and fails
the deploy if the marker is absent.

### The second reason to declare it: Dependabot reads the lockfile version

Measured 2026-08-27, and it decides the ecosystem's bun for reasons that have nothing to do with any
one host:

| Question | Answer |
| --- | --- |
| What does a *fresh* `bun install` write under bun 1.4.0? | `"lockfileVersion": 2` |
| What does bun 1.4.0 do to an EXISTING v1 lockfile? | leaves it at 1, even when it must rewrite it |
| Which bun does Dependabot bundle? | **1.3.14** (`dependabot-core`, `bun/Dockerfile`, `ARG BUN_VERSION`) |
| What does 1.3.14 do with a v2 lockfile? | `UnknownLockfileVersion: failed to parse lockfile` |

Read together those four lines say something narrow and easy to trip over: **a repo's bun ecosystem
updates die the day someone deletes `bun.lock` and reinstalls on bun >= 1.4.0, and never before.**
Nothing warns. Dependabot simply stops opening pull requests for that directory, and a quiet
Dependabot looks exactly like a repo with no updates available. Portail-etu's lockfile went to v2 on
2026-08-26 and the next weekly run would have been the first to notice.

This is also why **Renovate is not needed** and the plan to migrate all five to it is dropped.
Dependabot's bun ecosystem works - it has been opening `/frontend` PRs on Canari for months - and the
only thing that breaks it is a lockfile version we control. Migrating would have traded a working
tool for a GitHub App install on every repo, to fix a problem that a pinned bun already fixes.

### Where each repo stands

| Repo | `.bun-version` | Why that number |
| --- | --- | --- |
| Canari | `1.3.14` | the newest bun Dependabot can follow |
| Portail-etu | `1.3.8` | the newest bun its deploy host can *run* |
| Sky / MiGallery / Le Cercle | owed | to be pinned as each is converted |

Canari had the worst of it before the pin: **three different bun versions across its workflows**
(1.2.18 in five, 1.4.0 in two) and `ci.yml` with no version at all - `setup-bun` with no `with:`
block resolves to *latest*, which is both the 401-prone path `cd.yml` already warned about in a
comment and the exact route by which a v2 lockfile could have entered the repo from CI. All eight
sites now read `.bun-version` through `bun-version-file`.

---

## What the inventory says, in one paragraph

The values are already unanimous wherever anyone bothered to state one - 4 seconds for an outbound
call, the same head, the same promise about a typo. **What differs is whether a repository states it
at all**, and the two clearest gaps were both closed the same day this was written: MiGallery had no
outbound deadline anywhere and now states the ecosystem's 4 s, and Le Cercle's search went from a
substring `LIKE` to a full matcher in somebody else's commit while this page was being written.
The three that were left closed on 2026-08-19 as well, and how they closed is the argument. Le
Cercle's CI turned out never to have been off - `db2a530` had removed the kill switch the day
before, and this page had read the claim out of a `CONTRIBUTING.md` instead of the file that defines
it; it then turned out not to be unobservable either, once the question was asked of what a pipeline
WRITES rather than of the one API that refused. Portail-etu's association filter became a real
matcher. And the tolerance ladder, the one thing
here that WAS a genuine disagreement, was settled by measuring the three ladders against the
production roster rather than by picking one: the loose ladder offered a wrong person on half of all
queries and recovered no typo the tight one did not. That is the whole argument against a shared
package and for a written contract - a package would have coupled five deploys and still left each
author to choose their own numbers, whereas
[search-contract](search-contract.md) is one page, four implementations, four tests that pin it.

## Related

- [frontend/seo.md](frontend/seo.md) - the worked example of one method in four repositories
- [durable-rules.md](durable-rules.md) - the rules these divergences were measured against
- [search-contract.md](search-contract.md) - the contract this page's first finding turned into
- [backlog.md](backlog.md) - where anything this page turns into work is scheduled

---

## 9. TypeScript 7: possible, measured, and REFUSED on both halves of Canari - for two different reasons

The mandate says "TS7 partout ou c'est possible". On Canari it is not possible yet, and this section
exists so nobody spends another evening finding that out. Measured 2026-08-27 against
`typescript@7.0.2`, the `latest` dist-tag - a real release, the Go port, shipping a platform binary
per target rather than a JS compiler.

Both halves of the repo declare `^6.0.3` / `~6.0.3`. Both were bumped and both were reverted.

### The frontend: `svelte-check` agrees with TS 6 only through a flag that says it may break

`svelte-check` refuses TypeScript 7 outright unless BOTH majors are installed, the 7 aliased:

```
bun add -d typescript@~6 "@typescript/native@npm:typescript@7"
```

and then it offers two ways to use it. They do not agree with each other.

| Path | Result | Wall clock |
|---|---|---|
| TS 6, the supported path | 7978 files, **0 errors**, 0 warnings | 17.0 s |
| `--tsgo` (transpiles Svelte to disk) | 238 files, **7 ERRORS**, 2 files with problems | 5.8 s |
| `--tsgo-experimental-api` (in-memory) | 230 files, **0 errors**, 0 warnings | 7.8 s |

All seven `--tsgo` errors are the same shape - `Parameter 'e' implicitly has an 'any' type`, on the
`onerror` handler and the `failed` snippet parameters of `<svelte:boundary>`, in `+layout.svelte` and
`MainChatPage.svelte`. Svelte's own types give those parameters a type; the disk-transpile path loses
it. They are tooling artefacts, not defects.

So the only TS 7 path that tells the truth about this codebase is the one whose own help text reads
*"Experimental feature, might break without warning."* Gating every commit and every CI run on that,
to save nine seconds, is the opposite of the standing directive that everything be deterministic,
reproducible and explicable. **The frontend stays on TypeScript 6.**

Re-run the table above when `--tsgo` stops inventing those seven; that is the single condition.

### The four NestJS services: `ts-jest` cannot run AT ALL under TypeScript 7

`core-service` COMPILES clean under 7.0.2 - `bunx tsc -p tsconfig.build.json` exits 0. Then the suite:

```
Test Suites: 17 failed, 17 total
Tests:       0 total

TypeError: Cannot read properties of undefined (reading 'fileExists')
  at ConfigSet._resolveTsConfig (ts-jest/dist/legacy/config/config-set.js:516:97)
```

Not one suite even loads. `ts-jest` reaches for a compiler-API surface (`ts.sys`) that the native
package does not expose. Reverted, the same 17 suites pass 157 tests. **The services stay on
TypeScript 6** until `ts-jest` ships TypeScript 7 support - that is the single condition, and it is
somebody else's release, not our work.

Note how this compounds with the OTHER measured limit on this repo: these suites already cannot run
under the bun runtime (section 8). Jest is now the reason for two separate pins.

### The guard

Both conditions are somebody else's release, so both will look "ready" the day a bot proposes them.
`dependabot.yml` therefore ignores `typescript` majors on `/frontend` and on the four service
directories, with a pointer back here - because `dependabot-auto-merge.yml` is enabled on this repo,
and without the ignore the path from "Dependabot opens a PR" to "every backend test suite fails to
load on main" has no human in it.

---

## 10. bun 1.4 as the RUNTIME everywhere, lockfiles held at v1 - and why that is not a compromise

Measured 2026-08-27. This section replaces the reasoning behind the `.bun-version` pin, which was
defensive against something that turns out to be separable, and it closes the Renovate question that
had been open since the package-manager work began.

### The constraint, dated and precise

Dependabot merged [PR #15896](https://github.com/dependabot/dependabot-core/pull/15896) on
**2026-08-14**. It bundles bun **1.3.14** and sets `MAX_SUPPORTED_LOCKFILE_VERSION = 1`. Handed a
`bun.lock` carrying `lockfileVersion: 2` it now raises `DependencyFileNotSupported` - a HARD failure,
which is a deliberate improvement on what it did before ([issue
#15848](https://github.com/dependabot/dependabot-core/issues/15848)): bun 1.3.5 could not parse a v2
lockfile, discarded it, resolved from scratch and committed a **downgraded v1 lockfile back into the
pull request** with exit code 0. Silent corruption became a loud refusal. Either way, **a v2 lockfile
means no dependency updates for that directory.**

### The separation the old pin missed

The `cd.yml` comment said "any bun >= 1.4.0 writes `lockfileVersion: 2` into a `bun.lock` **it
creates**", and that qualifier is the whole point: **the version of bun you RUN and the version of
the lockfile you COMMIT are independent.** bun 1.4.0 writes v2 only when creating a lockfile from
nothing. Against an existing v1 lockfile it preserves the version. Measured three times, three
different commands, three different repositories:

| Command | Where | Result |
|---|---|---|
| `bun update fast-uri` | `apps/core-service` | v1 preserved, dependency bumped 3.1.2 -> 3.1.6 |
| `bun install` | Sky (14 packages installed, 16 removed) | v1 preserved |
| `bun install --frozen-lockfile` | `apps/media-service` | **byte-identical** lockfile, `diff -q` clean |

The third is the one CI actually runs. So bun 1.4.0 can be the runtime in every image, every workflow
and every developer's shell while Dependabot keeps working - **as long as the manifest stays inside
what the v1 format can express.** That qualifier is not decoration. It was found by breaking it.

### The exception, measured 2026-08-27: the manifest gets a vote

The rule above says "creating a lockfile from nothing", and that is INCOMPLETE. bun 1.4.0 also
rewrites the version when the manifest holds something v1 cannot record. Handed
`apps/chat-delivery-service` - the one service of four whose `overrides` block was NESTED - a plain
`bun install` against an existing, committed **v1** lockfile wrote **`lockfileVersion: 3`**. It
changed nothing else: the entire diff was the version line and the three nested blocks it could now
store.

| Command | Where | Result |
|---|---|---|
| `bun install` | `apps/chat-delivery-service`, nested `overrides` | **v1 -> v3**, 16-line diff, `no changes` across 732 installs |
| `bun install` | the same, once the nesting was flattened | **v1 preserved**, lockfile byte-identical |

bun 1.3.x did not support nested overrides **and said so** - three `warn: Bun currently does not
support nested "overrides"` lines on every install, which is precisely how a warning gets learned as
noise and skipped. 1.4.0 supports them, and pays for it with a format Dependabot refuses. The upgrade
did not break the invariant by accident: it broke it by implementing a feature this manifest had been
asking for all along, unheard.

**The symptom was never the version.** The committed lockfile was still v1, so the guard never fired -
`bun install --frozen-lockfile` did, in THREE jobs at once, under
`note: overrides in package.json changed since bun.lock was saved`. A frozen install compares the
manifest's overrides with the lockfile's, and 1.4.0 saw three the lockfile had never recorded. CI, CD
and the Docker build went red together, on a commit that touched none of them.

So the honest general form is stronger than the version number it corrects: **A LOCKFILE VERSION IS
NOT A PROPERTY OF THE TOOL ALONE - THE MANIFEST GETS A VOTE.** What spares the gate below from ever
having to fire is a manifest that stays inside what v1 can express.

### What the nested overrides were actually holding

Deleting them was the obvious fix and it was WRONG, which only a clean re-resolve could show. A
`bun install` from no lockfile at all, against the flattened manifest, put `uuid@9.0.1` back under
both `gaxios` and `teeny-request` and `bun audit` immediately named
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) - *missing buffer bounds
check in v3/v5/v6, `<11.1.1`*, reached by `firebase-admin > google-auth-library > gcp-metadata >
gaxios > uuid`. **The `^11.1.1` was the fix for that advisory.** The existing lockfile hid this
perfectly: it still pinned `gaxios/uuid@11.1.1` from the npm era, so a frozen install stayed clean
and `bun audit` stayed green while the manifest's reason for it had been deleted. Only a resolve from
NOTHING asks the manifest to prove itself.

`@types/request > form-data: ^2.5.6` was the opposite and the clean resolve settled that too: the
package declares `form-data: ^2.5.5`, resolves to 2.5.6 unaided, and the audit is clean without the
override. It is gone, and nothing replaced it.

### Why the pin is on `uuid` and not on `gaxios`

Three flat forms could carry the same guarantee, and two of them are worse:

- **`"gaxios": "^7"` + `"teeny-request": "^10"`** removes the vulnerable edge at the root rather than
  patching the leaf - gaxios 7 dropped its `uuid` dependency entirely. But FOUR packages in this tree
  still declare `gaxios: ^6.x`, and 7 is a major that moved to `fetch`. Forcing it through
  firebase-admin's auth path is a runtime change no build proves.
- **`"uuid": "^14"`** looks like the tidy dedupe until you open the package: 14.0.2 is `"type":
  "module"` with no `main` and no `require` condition in its exports, and `gaxios/build/src/gaxios.js`
  line 63 is `const uuid_1 = require("uuid")`.
- **`"uuid": "^11.1.1"`**, which is what is committed. It is the version production has actually been
  running for these two consumers, it satisfies the advisory exactly, and it keeps a `require`
  condition.

A flat override reaches direct dependencies too, so `uuid` had to stop being one. It barely was: two
call sites, `groups.controller.ts` and `calls.service.ts`, each a bare `uuidv4()` - and
`groups.controller.ts` already imported `crypto` on the very next line and called
`crypto.randomUUID()` at line 42. Both are now `crypto.randomUUID()`, the direct dependency is gone, and the override governs
only the transitives it was written for.

**Pinning the toolchain to 1.3.14 never enforced the invariant anyway.** `.bun-version` governs CI
and `setup-bun`; it does not govern the bun on a contributor's laptop, and a contributor on bun 1.4
who deletes `bun.lock` and reinstalls produces a v2-or-later lockfile whatever this repo pins. The pin bought
an illusion. **What actually enforces it is a gate that reads the committed lockfiles**, which is why
one exists now - it names this section, and it fails the build rather than letting Dependabot go
quiet, which is the failure mode nobody notices because its symptom is an ABSENCE of pull requests.

### Renovate: still unverified, and now unnecessary

The standing plan was to replace Dependabot with Renovate, conditional on one check nobody had run -
does Renovate read `lockfileVersion: 2`? **It still has not been answered, and it cannot be answered
from the documentation.** The [bun manager
page](https://docs.renovatebot.com/modules/manager/bun/) lists `bun.lockb` and `bun.lock` as
supported and says only that "lock file maintenance is delegated to the underlying package manager,
which Renovate runs as an external command". It never states how the bun version is chosen - not
`packageManager`, not `.bun-version`, not a bundled pin. Since which bun runs is exactly what decides
whether a v2 lockfile is readable, the documentation does not settle the question.

**It no longer needs to be settled.** The reason to want Renovate was v2 lockfiles, and the
measurement above removes the reason to want v2 lockfiles. **RENOVATE STAYS DROPPED** (decided
2026-08-27, and this section is why). Reopen it only if bun stops being able to preserve a v1
lockfile, or if Dependabot raises `MAX_SUPPORTED_LOCKFILE_VERSION` and v2 buys something concrete -
and note that in the second case the answer is to move to v2 on Dependabot, not to switch tools.

### The version inventory, all five repos, 2026-08-27

`svelte`, `@sveltejs/kit` and `vite` are ALREADY identical across all five: `^5.56.10`, `^2.70.3`,
`^8.2.2`. The homogeneity mandate has three outstanding divergences and no more:

| Divergence | Repo | Everyone else |
|---|---|---|
| `tailwindcss@^4.3.1`, and NO `@tailwindcss/vite` (still on the PostCSS path) | MiGallery | `^4.3.3` + `@tailwindcss/vite@^4.3.3` |
| `lucide-svelte@^1.0.1` - the OLD package name | MiGallery | `@lucide/svelte@^1.34.0` |
| `typescript@^6.0.3` - caret, not tilde | le-cercle | `~6.0.3` |

The caret is a homogeneity defect and NOT a TypeScript 7 hole: `^6.0.3` resolves `< 7.0.0`, so it
cannot pull in the major that section 9 refuses. Fix it for consistency, not for safety.

### Stale Svelte 4 syntax: none, anywhere

Swept 2026-08-27 across the `src/` of all five repos for `export let`, `on:click`/`on:change`/
`on:submit`/`on:input`, `createEventDispatcher`, `<slot`, `<svelte:component` and top-level `$:`.
**Every count is zero in every repo.** The runes migration is complete and there is nothing to do
here - recorded so the question is not re-opened by someone who assumes otherwise.

## 11. What the other three repos still owe, repo by repo (2026-08-27)

Canari's half of the mandate is closed. This section is the working list for the rest, moved here
from `CLAUDE.md` so the root index can point at it instead of restating it. **All three still owe a
`.bun-version`**, and **section 9 must be read before TypeScript 7 is touched on any of them.**

### Sky - NON-BUILDABLE, mid-migration

An earlier session left it part-way through and it does not build as it stands. In order:

1. `bun install` (pending - this is what makes it non-buildable)
2. 36 `lucide-svelte` -> `@lucide/svelte` imports, plus roughly 4 deprecated icon names
3. Dockerfile onto bun
4. `ci-bun.yml`
5. pm2 out of `deploy.yml`
6. `dependabot.yml`
7. five docs pages
8. the gates
9. commit SPLIT IN TWO - substance first, the oxfmt reformat separately, or neither is reviewable

Decided and not to be relitigated: Sky keeps Tailwind and migrates to v4 without a preflight, and
`bun:sqlite` replaces better-sqlite3.

### MiGallery

npm -> bun; an audit of its 17 scripts; 68 lucide icons; Tailwind from the PostCSS plugin to the Vite
one; oxlint/oxfmt/oxvelte; TypeScript 7; 4 vulnerabilities; the duplicate `.eslintrc.json` beside
`eslint.config.js`; a `code-analysis.yml` that is still pending; and a `dependabot.yml` harmonised
with the others.

### le-cercle

oxlint/oxfmt/oxvelte; TypeScript 7, which here means fixing the `^6.0.3` caret recorded in section 9;
and Dependabot, which on GitLab is not the same product as on GitHub.
