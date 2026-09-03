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
| **Portail-etu** | oxfmt + oxlint + oxvelte | yes (`test.yml`, `deploy.yml`) + pre-commit and pre-push hooks | yes | yes |
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

### Dependency updates: the same three defects everywhere, and the ceiling that does NOT copy

The auto-merge workflow was one file copied into four repositories, so **all four carried all three
of its defects**: no ceiling, so it merged anything green; one trigger, `workflow_run`, so it could
only act on an event it happened to catch; and a merge that reached no deploy, because a squash made
with `GITHUB_TOKEN` raises no `push` event. All four are fixed (2026-08-31). The state, and what is
still unproven, is the table on [backlog](backlog.md).

**The script copies; the ceiling does not, and that is the whole design.** An entry is a dependency
whose failure would be INVISIBLE to that repository's own suite - never a semver judgement, because
a break that stops the tree compiling is caught and merges on its own. So each repository was
MEASURED separately, and the four answers came out genuinely different:

| Repo | Its answer | Why |
| --- | --- | --- |
| **Canari** | five entries | a wire format read by other devices on other versions, a channel-push seal, an ICE stack ten tests never touch - none of it observable from a build |
| **Sky** | EMPTY | all three candidates were closed by WRITING the test: a frozen star-map layout, a packaged-server boot, and a markdown-escaping gate |
| **MiGallery** | two | `jspdf` (a PDF nothing ever opens) and `form-data` (the streaming multipart body of the one path a photo takes in). `sharp` was the largest and is closed by `tests/face-crop.test.ts` |
| **Portail-etu** | EMPTY | both candidates closed the same way - the boot step and the markdown gate |

**An empty ceiling is a correct answer**: it says that repository's suite is evidence about
everything it depends on. What is NOT acceptable is an entry with no named test, which is a refusal
nobody can ever lift - the queue the whole mechanism exists to avoid (user, 2026-08-31: *"Je prefere
blinder de test et faire les choses automatiquement qu'avoir une review humaine qui n'arrive
jamais"*).

**Writing the ceilings is what found the defects.** Not one of them was visible to any gate in its
own repository: Sky's star map rotating on every `rebuild-db` and its bios rendering raw `<iframe>`;
MiGallery's undeclared `@types/node`, its image caches that stopped caching for ever if their
directory vanished, and two dependencies nothing imported; Portail-etu's bios with the same
`<iframe>` hole and an adapter nothing ever started outside production. **Asking "what would break
here without anything going red" is a better bug-finder than looking for bugs.**

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

### A label in `dependabot.yml` is a REFERENCE, and the repo has to hold it (2026-08-31)

Reported by the user from a bot comment on PR #253: *"The following labels could not be found:
github-actions. Please create it before Dependabot can add it to a pull request."* Dependabot does
not create a label it is told to apply - it opens the PR without it and comments the refusal.

**Four were missing, not the one the comment named**, which is the whole reason to re-measure a
predicate against its population rather than fix the instance in front of you. Canari held only
`dependencies` and `rust`; `dependabot.yml` also names `github-actions`, `frontend`, `backend` and
`docker`, one per ecosystem, and every one of those four ecosystems would have produced the same
comment on its next PR. All four now exist (`gh label create`), and the four open PRs were labelled
by hand; the two Dependabot opened afterwards carried their labels on their own, which is the
measurement that the fix took.

**What it cost while broken is nothing and everything**: no update was blocked, no PR was missed -
but the labels are what `open-pull-requests-limit` groups are read through, so a repo with a hundred
dependency PRs was sorting them by title. The check is one command:

```bash
gh label list --limit 100        # against every `labels:` block in .github/dependabot.yml
```

**A `dependabot.yml` naming anything the repo must already hold - a label, a reviewer, a milestone -
is a reference that fails at USE time, in a bot comment nobody is paged for.** Add it to the repo in
the same commit that adds it to the config.

### Where each repo stands

| Repo | `.bun-version` | Why that number |
| --- | --- | --- |
| Canari | `1.3.14` | the newest bun Dependabot can follow |
| Portail-etu | `1.3.8` | the newest bun its deploy host can *run* |
| Sky / MiGallery / Le Cercle | owed | to be pinned as each is converted |

Canari had the worst of it before the pin: **three different bun versions across its workflows**
(1.2.18 in five, 1.4.0 in two) and `ci.yml` with no version at all - `setup-bun` with no `with:`
block resolves to *latest*, which is both the 401-prone path `deploy.yml` already warned about in a
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

## 9. TypeScript 7: REFUSED on both halves of Canari, ADOPTED on MiGallery - all three measured

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

### MiGallery: the same tool, the same flag, and it works - measured 2026-08-27

The frontend verdict above is about `--tsgo` inventing seven errors, and **all seven were on
`<svelte:boundary>` parameters**. MiGallery uses no `<svelte:boundary>`. So the condition that
blocks Canari does not bind there, and the non-experimental path is clean:

| Path | Result | Wall clock |
|---|---|---|
| TS 6, the baseline | 5396 files, **0 errors** | 8 s |
| `--tsgo` | 121 files, **0 errors** | 5 s |
| `--tsgo-experimental-api` | 44 files, 0 errors | 5 s |

**A clean run is not evidence until you have shown the tool can fail.** Three probes, each planted
and then reverted: a type error in `src/lib/__tsprobe.ts`, one in a route `.svelte`
(`src/routes/albums/+page.svelte`), one in `tests/api.test.ts`. `--tsgo` reported every one, at
the same line and column TS 6 reported it. It reads `.svelte` and it reads `tests/`.

**The file count is a COUNTER difference, not a coverage gap, and it will look like a regression to
the next reader.** 5396 counts every `.d.ts` under node_modules plus the 606 generated Paraglide
files; 121 is roughly the checkable source. The probes are what settle it, not the number. Both
figures are in MiGallery's own `CLAUDE.md` for that reason.

`check` and `check:watch` now carry `--tsgo`, in the same shape Sky already used, and BOTH majors
stay installed because svelte-check requires it: `typescript` at `~6.0.3` for its own API,
`@typescript/native` at `npm:typescript@^7.0.2` for the Go compiler. Its `dependabot.yml` still
holds `typescript` majors and its comment now gives the real reason: a major there would REPLACE
the stable compiler svelte-check is using.

**Proven on the platform CI runs.** A Go compiler ships one binary per target, the lockfile was
written on Windows, and `bun install --frozen-lockfile && bun run check` completes inside a
`node:24-bookworm-slim` container. This is the lightningcss lesson applied before it could bite:
the lockfile lists all 20 `@typescript/typescript-*` platform packages, and that was checked, but
the container is what proves it.

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

The `deploy.yml` comment said "any bun >= 1.4.0 writes `lockfileVersion: 2` into a `bun.lock` **it
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

## 11. The cross-repo convergence plan, repo by repo

The working list for the mandate, and the ONLY copy - `CLAUDE.md`'s index points here rather than
restating it.

**Read the table before planning anything, and add to it rather than re-deriving it.** Every cell
was established by running the command named. This list was rewritten twice in one week because it
described Sky from memory instead of from a measurement, and each rewrite paid for the same
discovery again.

### How each repository is REACHED, and what its box refuses

Operational, not architectural, and each line was learnt by being caught by it.

- **Portail-etu (`../refonte-portail-etu`) has NO SSH.** The self-hosted CD runner is the only way
  in; `deploy.yml` carries a `workflow_dispatch` for it. **A dispatch can return 500 while STILL
  creating the run** - check `gh run list` before re-dispatching, or two deploys race. The repository
  is PUBLIC, so every run log must be redacted before it is quoted, and `grep -a` is mandatory
  (the logs are served as binary and a plain `grep` silently reports "binary file matches"). Flush
  logs with `pm2 flush`, never `rm` - pm2 keeps the descriptor open and an unlinked file grows
  invisibly until the disk is full. **`data-export/` holds PII and is never committed.**
- **le-cercle (`../le-cercle`, `gitlab.emse.fr:aurel.dautry/le-cercle`) is Aurel's repository**, but
  our rewrite is merged (!5, !6) and we hold push rights. Reading its pipeline needs `glab`, **run
  from INSIDE that tree** - it resolves the project from the git remote and answers about Canari
  from anywhere else.
- **Canari and Portail-etu are both PUBLIC.** Nothing secret may reach either, in code, in a
  fixture, or in a pasted log.

### The measured state, 2026-08-27

| Repo | `.bun-version` | Lockfile | oxlint/oxfmt | TS 7 | Gates, as measured |
|---|---|---|---|---|---|
| Canari | 1.4.0 | 5 x `bun.lock`, all **v1** | yes | REFUSED, section 9 | green |
| Sky | 1.4.0 | `bun.lock` **v1** | yes | `--tsgo` already wired into `check` | `check` 43 files 0 errors 2 unused-CSS warnings; `lint` 0 errors 8 warnings; `build` green; image built, container started, `/api/health` 200 |
| MiGallery | 1.4.0 | `bun.lock` **v1** | yes | **ADOPTED**, `--tsgo`, section 9 | `check` (TS 7, `--tsgo`) 121 files 0 errors - 5396 under TS 6, a counter difference proven not to be a coverage gap; `lint` 0 errors, 88 warnings; `format:check` clean; `bun audit` 0 vulnerabilities across 346 packages; image builds, container healthy, `/api/health` 200, and the CSS it serves carries its vendor prefixes |
| le-cercle | 1.4.0 | `bun.lock` **v1** | yes, plus oxvelte | **ADOPTED**, `--tsgo`, section 9 | `check` (TS 7) 90 files 0 errors - 5174 under TS 6, the same counter difference as MiGallery and proven the same way; `lint` 0 errors 0 warnings; `lint:svelte` 0 on the recommended set; `format:check` clean; 95 tests pass; `bun audit` 0 vulnerabilities across 204 packages; `build` green |
| Portail-etu | **1.3.8** | `bun.lock` **v1** | yes, plus oxvelte | **ADOPTED**, `--tsgo`, and it was adopted here BEFORE the toolchain migration | `format:check` 86 files clean; `lint` 0; `lint:svelte` 0 on the recommended set **with no config file at all**, the only repo here in that state; `check` (TS 7) 35 files 0 errors; 70 tests pass; production build green |

**All four committed `bun.lock` are v1**, so Dependabot is alive in every directory that has one.
Portail-etu sits at 1.3.8 deliberately: its host cannot start a bun >= 1.3.9.

### Sky - DONE (`e0bd000`, 2026-08-27)

This list said "NON-BUILDABLE, `bun install` pending" and "36 `lucide-svelte` imports". Both were
stale before anyone read them: `node_modules` was present, `@lucide/svelte` was at `^1.34.0` with
**zero** `lucide-svelte` imports left, and oxlint/oxfmt/oxvelte were already wired. `ci-bun.yml`
and `dependabot.yml` existed too. Four of the nine steps were already done and the list did not know.

**The build did fail**, for a cause nobody had written down. `vite build` died with
`ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'bun:'` under **Node.js v24.13.0**: `bun run`
honours a bin's node shebang, so Vite ran under Node, and SSR then loaded
`src/lib/server/database.ts`, which imports `bun:sqlite` - a Bun builtin. This is the Portail-etu
rule biting a second repo, and the better-sqlite3 -> `bun:sqlite` migration is what armed it. The
silent Node execution had been harmless for as long as nothing imported a `bun:` module. `dev`,
`build` and `preview` now say `bun --bun vite ...`; `test` stays on `vitest run` under Node, where
its suite is green.

**The Dockerfile was the broken half** and would have failed at run time even once it built: it
copied a deleted `package-lock.json`, ran `npm ci && npm rebuild better-sqlite3` against a
dependency that is gone, installed python3/make/g++ for a native module nothing loads, and started
the container on `migrate-drop-profile-columns.js` - renamed to `migrate-drop-dead-schema.js`. Both
stages are now `oven/bun:1.4.0-alpine`.

`deploy.yml` lost its pm2 cutover step, and not on faith: the host no longer has the binary at all
(`/home/mitv/.bun/bin/pm2` absent), so both lines could only ever be no-ops behind their `|| true`.

**Verified locally, then IN PRODUCTION.** Locally: `docker build` green, container started, four
migrations ran, `GET /api/health` 200. In production after the deploy went green on `1e9d62d`:
`sky-sky-1` up and healthy, `bun --version` inside it says **1.4.0**, `docker inspect` shows the
corrected chain, and `https://sky.mitv.fr/` answers 200.

The production logs also proved the defect had been real rather than theoretical:
`migrate-drop-dead-schema` applied **7 operations** on that first start - three FTS triggers, the
`people_fts` table, `people.bio`, `people.image_url` and `external_links`. It had NEVER run,
because the Dockerfile invoked it under its old name. The migration nobody could see failing is
the one the rename had silently disabled.

The plan demanded the work be split into substance and the oxfmt reformat, and it now is, across
three commits: `e0bd000` substance, `44dac39` the CI repair, `1e9d62d` the reformat alone (100
files, mechanical).

**The reasoning that nearly skipped the split is worth keeping, because the measurement was sound
and the conclusion did not follow.** HEAD was re-formatted with the new oxfmt config and compared
file by file against the working tree; the formatting-only set came back EMPTY, which was read as
"there is no separable reformat here". What it actually showed is that no file's change was
formatting-ONLY - true, every touched file also carried substance - and it said nothing about
whether the reformat had been RUN. It had not: `format:check` failed on more than 100 files
minutes later. **A test for "is this change purely cosmetic" is not a test for "has the formatter
run"**, and only the second question decides whether a reformat commit is owed. `ci-bun.yml` now
runs `format:check`, so the tree cannot drift again unnoticed.

Decided and not relitigated: Sky keeps Tailwind and migrates to v4 without a preflight, and
`bun:sqlite` replaces better-sqlite3.

### MiGallery - the package-manager half is DONE, 2026-08-27

**Its runtime is NODE and stays node.** Two independent measurements say so, and they are recorded
here so no one spends the afternoon re-deriving them:

- `better-sqlite3` is a V8-ABI addon and **segfaults bun 1.4.0 outright** - a plain `:memory:`
  open produces a `bun.report` crash dump. It loads fine under node from the very tree bun
  installed.
- `ci.yml` already carried the other half, written by someone else before this work started: bun
  **as a runtime** inflated every incoming request-body read ~80x and retained the memory under
  mimalloc (neither `Bun.gc` nor glibc `malloc_trim` reclaim it), which **OOM-killed prod**.

So the split here is bun installs, node executes - and unlike Sky, `bun:sqlite` is NOT the escape
hatch, because it would be a rewrite of the whole data layer rather than a swap. Both reasons now
live in the Dockerfile and in `ci.yml`; do not collapse the two halves without re-running both.

**What shipped:** `bun.lock` committed and `package-lock.json` deleted AND gitignored in its place
- the `.gitignore` named npm "the project's package manager", so nothing else could land while it
said so. Scripts, both husky hooks, `ci.yml`, `release.yml`, `code-analysis.yml`,
`dependabot.yml`, the Dockerfile and every doc that told an operator to run a vanished command.
`RELEASE_NOTES.md` was deliberately left alone: it records what was true when written.

**Two things this cost that are worth keeping:**

- `scripts/ci-local.mjs` and `scripts/test-with-server.mjs` held REAL `spawn('npm', ...)` calls,
  not prose. A grep for `npm |npx ` missed them because the literal is `'npm',`. **A grep for a
  command name must include the form it takes as an ARGUMENT**, not only the form it takes at the
  head of a shell line.
- The Dockerfile's `python3 make g++` looked vestigial - `better-sqlite3@13` ships prebuilds for
  eight platforms and declares no `install` script - and removing them **failed the build**:
  `Could not find any Python installation to use`. bun, like npm, defaults a package that ships a
  `binding.gyp` and declares no install script to `node-gyp rebuild`, so it compiles from source
  and the prebuilds are never consulted. **A shipped prebuild is not evidence that the prebuild is
  what gets used.**

**The npm-on-Windows hazard is retired against a measurement.** MiGallery's `CLAUDE.md` carried a
rule born of commit `16eae58`: npm on Windows rewrote `package-lock.json` against the Windows
optional-dependency tree, dropped Linux-only entries (`@emnapi/*`) and broke `npm ci` on the
runner. `bun.lock` records every platform's optional dependencies, and the lockfile generated on
Windows drove a Linux `bun install --frozen-lockfile` through a complete production image build
that answers 200. The rule is rewritten, not merely deleted.

`code-analysis.yml` also gained a `dependencies` job it never had - nothing in that repository
checked a dependency against a published advisory, and nothing guarded the lockfile-version
invariant that keeps Dependabot able to open the PR that would fix one.

**The tooling half shipped too, 2026-08-27** - oxlint/oxfmt/oxvelte in place of eslint+prettier
(the duplicate `.eslintrc.json` beside `eslint.config.js` went with them), then the two below.
`bun audit` now reports **no vulnerabilities across 346 packages**: the four this list carried were
never MiGallery's own, they were the eslint/prettier tree's, and removing it removed them.

**lucide, `fae2c37`.** `@lucide/svelte` replaces `lucide-svelte` across 29 files and 79 distinct
icon names, each one verified to exist in `dist/icons/` rather than `dist/aliases/` - which in
1.34.0 still re-exports **254** deprecated names that render correctly right up until a major drops
them. Two things are worth keeping from it:

- **A deprecated package name announces nothing.** Both specifiers resolve and both render, so the
  guard is a CI grep, not a lint rule: oxlint's `no-restricted-imports` was measured first and
  **fires on `.ts` but NOT inside a `.svelte` `<script>` block**, which is where almost every icon
  import lives. A rule that covers the minority reads as a guarantee.
- **The rename was hiding a type that had stopped being true.** `AdminPage`, `EmptyState` and
  `ErrorState` typed their `icon` prop as `ComponentType<SvelteComponent>`, the Svelte 4 CLASS
  shape. No lucide icon has satisfied it since the package moved to runes; it typechecked only
  against the legacy shim the old package still carried, and **twenty errors across seventeen call
  sites surfaced the moment that shim left**. One alias in the icon registry now names the
  function-component shape.

**Tailwind on its Vite plugin, and the prefixing that nearly went with PostCSS.** `@tailwindcss/vite`
replaces the PostCSS wrapper, so `postcss.config.cjs` goes - **and autoprefixer with it.** That was
the trap, and it is the reason this is written down: the source writes `backdrop-filter` fifty times
and `-webkit-backdrop-filter` five, so **forty of the forty-five prefixed declarations in the built
CSS were autoprefixer's**, as were all five `-webkit-user-select`. Every glass surface in that app
would have lost its blur on Safari and iOS, silently, with a green build and a passing suite.
Lightning CSS takes the job over for Tailwind's output and the hand-written `<style>` blocks alike.

Verified declaration by declaration against the previous build rather than by eye: **2369 unique
declarations before, 2610 after, seven changed and none lost** - `-o-object-fit` for Opera 12 which
`not dead` excludes, `-webkit-mask-image` GAINING a `-webkit-radial-gradient` value, and
`.transition` falling back to the v4 theme defaults instead of a hard-coded `0s`. Then, because
`lightningcss` is a native binary and the lockfile was written on Windows: the production image
builds, reports healthy, answers 200, and **the CSS it serves carries the prefixes** - which is the
only thing that proves Lightning CSS ran on Linux rather than falling back.

`tailwind.config.cjs` is deleted outright. Nothing declared `@config`, so Tailwind 4 never loaded
it: its `content` globs, its empty `theme.extend` and its empty `plugins` had no effect on any
build that has ever run. `app.css` moves from the v3 `@tailwind` directives to `@import
'tailwindcss'`.

**TypeScript 7 is IN**, on `--tsgo` - the first repo here where it is possible. Section 9 carries the
measurement.

**Still owed there: a decision on 88 warnings, which are not noise.** The lint gate is 0 errors, but
what it lists is a real backlog and nobody has ruled on it:

| Rule | Count | What it means here |
|---|---|---|
| `svelte/require-each-key` | 25 | keyless `{#each}`; Svelte reuses DOM nodes across updates |
| `svelte/no-at-html-tags` | 20 | `{@html}`; each one is an XSS surface to audit individually |
| `svelte/prefer-svelte-reactivity` | 16 | plain `Map`/`Set`/`Date` under runes - state that does not react |
| `svelte/no-useless-children-snippet` | 8 | cosmetic |
| `unicorn/*` (`prefer-string-starts-ends-with`, `no-new-array`, `no-useless-spread`) | 12 | cosmetic |
| `eslint/no-unused-vars` on catch params | 3 | swallowed errors, in `scripts/` |
| `svelte/no-unused-props`, `no-unused-expressions`, `no-self-assign`, `no-useless-catch` | 4 | the last two, in `src/routes/parametres/+page.svelte`, may be deliberate reactivity tricks - **do not sweep them** |

The first three rows are correctness, not style. **Do not blanket-fix: `{@html}` and the two
`parametres` warnings each need a judgement.**

**Re-measured 2026-08-31: 70 warnings in 16 files**, down from 88 without anyone ruling on the
table above - the dependency work of that day removed files and rewrote others. **The count is the
wrong thing to track**; the table's first three rows are, and none of them is closed. Read the
current list from `bun run lint` rather than from a number here, which has now been stale once.

**The sibling counts, same day, same command:** Sky 8 warnings in 4 files, all
`svelte/require-each-key` - the same correctness class as MiGallery's largest row, and small enough
to close in one pass. Portail-etu is at **zero**, on both `lint` and `lint:svelte`, which is what
makes it the reference for what the other two are carrying.

### le-cercle - DONE AND MERGED (2026-08-27)

Two changes, and the repository's own `AGENTS.md` governs how each landed: it forbids committing to
`main`, so nothing here followed Canari's rule.

**The security fix is on `main`** (`1b5628f`), pushed on the user's explicit decision of 2026-08-27
rather than through a merge request - the exception, taken knowingly, because a ReDoS reachable
unauthenticated on every route was sitting on one laptop. It had to be rebased onto eight of Aurel's
commits first; the only conflict was `CHANGELOG.md`, resolved by keeping both entries. Every gate was
re-run after the rebase before the push.

**The tooling migration is merge request !5**, branch `chore/tooling-convergence`, one commit
(`ac54e17`). oxfmt, oxlint and oxvelte replace prettier, eslint and `lint-staged`; TypeScript 7 is
adopted; `.bun-version` says 1.4.0. The whole of it, with every measurement, is on that repository's
own [`docs/wiki/tooling.md`](https://gitlab.emse.fr/aurel.dautry/le-cercle/-/blob/main/docs/wiki/tooling.md) -
this page keeps only what the ecosystem needs to know:

- **The reformat touched five files.** The oxfmt options are the ones `.prettierrc` carried, and all
  five disagreements are the same multi-line union type. That is the number to quote when the next
  repository asks what this migration costs.
- **oxvelte is pinned by commit sha in all three repositories now** - `7196779a`, the fix found on
  le-cercle and carried back here and to MiGallery the same day, cache keys included. See the entry
  in [durable-rules](durable-rules.md).
- **The `oxvelte.config.json` that all three carried is deleted from le-cercle ONLY, and the other
  two keep theirs because they need them.** It disables `svelte/no-navigation-without-resolve`,
  inherited from the ESLint config it replaced; that IS an oxvelte rule and a recommended one. The
  file was first measured by dropping the `--config` flag, which measures nothing - oxvelte
  discovers the file in the working directory regardless - and the resulting "identical verdict"
  nearly deleted a live suppression from two repositories. Moving the file aside instead:
  **le-cercle 0 either way** (the rule fires nowhere in its 53 components, so the file went),
  **Canari 0 with and 92 without, all 92 that rule**, MiGallery 70 with and 86 without, 16 that
  rule. See [durable-rules](durable-rules.md) for both halves of that mistake.
- **Those 108 suppressed warnings are a finding, not a cleanup.** `resolve()` from `$app/paths` is
  what SvelteKit 2.26+ wants around a route string; the disable was inherited from ESLint and
  re-justified by nobody. Adopting it is 92 call sites on Canari and 16 on MiGallery and belongs in
  the queue on its own, not folded into a tooling commit.
- **The pipeline needed a second job.** The gates run inside `oven/bun:1.4.0-alpine` on a shell
  runner that is also the production host, and that image carries no Rust, so `gates:svelte` builds
  the pinned oxvelte revision in `rust:1.97.0-alpine3.22` - 1m47s, no package added to that image,
  measured locally against the working tree before the job was written - and caches it under a key
  naming the revision. The lint is therefore two scripts, `lint` and `lint:svelte`, not one.
- Two things were found by the migration rather than by anybody looking: an empty
  `src/lib/server/parse.ts` with no importer, which only surfaced once the linter ran over the whole
  repository instead of `src`; and a Dockerfile still on the floating `oven/bun:1-alpine`, the exact
  tag that repository's own pipeline had been pinned away from a week earlier, on the same host.

**!5 IS MERGED, AND ITS PIPELINE HAD TO BE READ BEFORE THAT COULD BE SAID.** Until 2026-08-27 this
page claimed every gate was green on the strength of a local run; the actual pipeline had failed
three times, and nobody here could see it because `glab` was not installed. Installed and
authenticated against gitlab.emse.fr, it reported the cause in one call. **Run `glab` from inside
that working tree**: outside it there is no remote to read, so `glab api` resolves the host as
gitlab.com and answers 404 - a wrong answer that looks like a missing resource, not like a
misconfiguration. And **the cause was not
the code**: `ENOSPC: copying file oxlint.linux-x64-gnu.node` during `bun install`, on a production
host down to 489 MB of a 7.8 GB disk. `gates:svelte` - the new job, the one carrying the executable-
bit trap - passed on the first read. **A local gate and a pipeline are two different statements, and
this repository is where that stopped being an abstraction.**

**That disk is its own defect, merged as !6**, and it is worth reading even from here because every
repository in this ecosystem deploys onto a self-hosted runner that is also the production host. The
`deploy` job had pruned on every run since its cutover and **both of its lines reclaimed 0 B**: one
removes DANGLING images while that pipeline tags every build `le-cercle:<sha>`, the other bounded a
cache by a CLOCK that a per-deploy rewrite outruns. Fourteen images and 1.5 GB of build cache later,
a merge request could not install its dependencies. Both rules are in
[durable-rules](durable-rules.md#shared-gotchas---development-cicd), with the two measurements that mislead - image
sizes are not additive (eleven images listed at 2.9 GB freed 486 MB) and the build cache, the
smaller number in `docker system df`, was the bigger half. Verified on the deploy that followed the
merge: the new block ran for real, reclaimed 839 MB, health check `{"status":"ok","schema":15}`,
disk **489 MB -> 2.1 GB free**, cache holding at 435 MB under its 512 MB bound.

What is left there: **Dependabot, which on GitLab is not the same product as on GitHub.** The
security commit already added `bun audit` to the gates, which is the part that matters - the
repository audits clean, so a red there is a new advisory.

### Portail-etu - DONE (`5ba4945` + `6d914ca`, 2026-08-27, CI green on run `33068835243`)

The last repository still on prettier and ESLint. It is on oxfmt, oxlint and oxvelte now, and the
migration cost almost nothing: **oxfmt disagreed with prettier about two files** - the leading-`|`
union type every repository here hit, and one `@import url(...) layer(base)` prettier had wrapped
across two lines to stay under 100 columns. The `.prettierrc` options were kept as they were, double
quotes and `trailingComma: "es5"` included; converging the tool is the point, converging the quote
style would have been a repository-wide diff for nothing.

Three things came out of it that are not tidiness:

- **The Svelte recommended ruleset had never run there.** `eslint.config.js` spread
  `svelte.configs.recommended.rules`, which in eslint-plugin-svelte 3 is an ARRAY of flat configs
  whose `.rules` is `undefined`. That repository's own backlog had carried the finding since
  2026-08-19 - 17 errors when the real set was spread in - and it stayed a backlog item because
  adopting it was a refactor. oxvelte runs its recommended set for real, finds **4**, and all four
  are dealt with in place: two `{#each}` blocks keyed on `item.href`, a local `Map` inside
  `$derived.by` justified as a plain `Map`, and `GlassCard`'s `href` justified as a prop the
  component cannot resolve on its caller's behalf. **Zero warnings and no `oxvelte.config.json` at
  all** - the only repository here in that state.
- **But 17 became 4 partly because the rule got narrower, not because the code got cleaner.**
  Measured: oxvelte's `svelte/no-navigation-without-resolve` flags a shorthand `{href}` and does NOT
  flag a string literal, so the three `href="/associations"` links in `Footer.svelte` that ESLint
  reported draw nothing from the new linter. Thirteen call sites that the previous gate had an
  opinion about are now unwatched. **That is the same rule Canari suppresses 92 times and MiGallery
  16** - three repositories, one open question, and it is written down in all three.
- **The first CI run failed anyway, and on nothing the local gates can see.**
  `scripts/install-oxvelte.sh` went in as `100644`: `core.fileMode` is false on this workstation, so
  a local `chmod +x` is never recorded, and every gate here passes because Windows ignores the mode.
  The runner does not - `Permission denied`, exit 126. Fixed in `6d914ca` by `git update-index
  --chmod=+x` on both scripts AND by invoking the installer as `sh "$SCRIPT_DIR/install-oxvelte.sh"`,
  so the mode stops being load-bearing at all. **The same trap was live in le-cercle's open merge
  request** and was fixed there in the same pass. The rule is in
  [durable-rules](durable-rules.md#shared-gotchas---development-cicd); what it cost is that the earlier container
  simulation had passed, because a Windows Docker bind mount presents every file as executable
  whatever git recorded - it simulates the commands, never the checkout.
- **The oxvelte shims had to be the POSIX ones, not Canari's.** Copying Canari's bash version was a
  bug caught before it shipped: `package.json` invokes them through `sh`, and on the CI runner `sh`
  is dash, where `set -o pipefail` and `${BASH_SOURCE[0]}` fail - and only there, so a workstation
  would never have shown it. le-cercle's POSIX versions were already proven under alpine's busybox
  `sh`, so they transfer with the measurement attached.

`lint-staged` went with prettier: the pre-commit hook used to run `prettier --write` and
`eslint --fix` over the staged files, which hands you a commit you have not read. It measures the
whole tree now and rewrites nothing.

**Two things are deliberately NOT done there**, and neither is an oversight. Tailwind class sorting
is off - that repository never had `prettier-plugin-tailwindcss` either, so turning `sortTailwindcss`
on would rewrite every `class` attribute in the same commit that swaps the toolchain, and reordering
two conflicting utilities changes which one wins. And `.bun-version` stays at **1.3.8** against the
ecosystem's 1.4.0, for two measured reasons that are constraints rather than preferences: bun's
runtime cannot start on that deploy host from 1.3.9 onward, and 1.4.0 writes `lockfileVersion: 2`,
which Dependabot cannot read.

**It is deployed and answering**, which is the only thing a green pipeline does not say: the
`Deploy to Server` run chained off that build finished green and `https://portail-etu.emse.fr`
returns 200. Full record on that repository's own `docs/wiki/tooling.md`.

### Canari - what is left of its own half

Its half is otherwise closed. Two things are not:

- **Prod runs bun - PROVEN 2026-08-27**, and this line records the measurement so nobody re-derives
  it: after CD went green on `90d79b19` (five red runs before it), `docker inspect` reports `bun
  dist/main.js` for all four NestJS containers, and `https://canari-emse.fr/` answers 200. The two
  Rust services run their own binaries, as they always did.
- `Dockerfile.frontend-ssr` onto `svelte-adapter-bun`, decided and not started. It must preserve
  the captured OG-tag baseline and be proven on prod.

**THE ONE MEASURED LIMIT ON "bun PARTOUT", and it is a limit on the TEST runner only.** jest fails
under the bun runtime: `admin-storage.controller.mls.spec.ts` passes 8/8 under node and fails under
bun. So CI **installs, lints and builds with bun, and TESTS with node**, and both call sites in
`ci.yml` say so in a comment. **Do not collapse that to one runtime without re-running that spec** -
the temptation is constant, because every other stage in the pipeline is bun and the asymmetry reads
like an oversight rather than a measurement.

### The second sweep, 2026-08-27: eleven gaps the first pass left

The migration half closed on 2026-08-27 and an audit run straight afterwards found eleven things
still divergent across the five repositories. They are recorded here with their measurements
because most of them were invisible to the check that would naturally be run for them.

| # | Gap | Where it was | Verdict |
| --- | --- | --- | --- |
| 1 | oxfmt in three versions (0.59 / 0.64 / 0.65) | all five | **CLOSED** - `^0.65.0` everywhere, and the bump reformats NOTHING |
| 2 | bun declared three times on Canari, two of them wrong | `frontend/package.json` | **CLOSED** - `packageManager` and `engines.bun` deleted |
| 3 | Sky states the `bun-version-file` rule then sets `bun-version: latest` | `code-analysis.yml` | **CLOSED** - the job that did it is deleted, not fixed |
| 4 | a dead `frontend/.husky/` running nvm and npm | Canari | **CLOSED** - deleted |
| 5 | docs naming npm, ESLint, Prettier and `lucide-svelte` | Canari, 12 files | **CLOSED** |
| 6 | two oxvelte shim dialects, bash and POSIX `sh` | Canari, MiGallery, Sky vs the rest | **CLOSED** - all five on the corrected `sh` pair |
| 7 | three lint scopes (`src` / `src scripts` / `.`) | all five | **CLOSED** - `.` everywhere; format keeps its globs, see below |
| 8 | in-range and out-of-range dependency lag | Canari, Sky, le-cercle | **CLOSED** for in-range; NestJS 11 -> 12 deliberately parked |
| 9 | `configVersion: 0` lockfiles; an empty `catch` in the hook installer | Sky + four services; Canari | **BOTH CLOSED.** The first pass called `configVersion` unclosable; it was wrong - see below |
| 10 | MiGallery's runtime is node while Sky's is bun, on the same host | MiGallery | see [MiGallery](#migallery---the-package-manager-half-is-done-2026-08-27) |
| 11 | five hand-written SVG icons instead of lucide | Portail-etu | see that repository's `docs/wiki/tooling.md` |

**What the manifests could not tell you (gap 1).** Five packages in Canari declared oxlint as
`^1.74.0` or `^1.80.0`. The LOCKFILES said three versions: 1.75.0 in chat-delivery, media and
social, 1.80.0 in core-service and the frontend - all five running the same repo-level config, so
a lint verdict depended on the directory you stood in. Fixing what the manifests showed would have
left one of the three in place. The rule is in
[durable-rules](durable-rules.md#shared-gotchas---development-cicd).

**oxfmt 0.59 -> 0.65 is a no-op on this code**, measured rather than feared: 799 frontend files,
303 service files, 267 MiGallery files, 114 Sky files, zero diffs. Worth having on record - a
formatter major is the one bump that can rewrite a whole tree, and that fear is what let three
versions coexist.

**Why the lint scope moved to `.` and the format scope did not (gap 7).** Scope `src` had never
read `frontend/scripts/`, and a clean run looks the same whether a directory is clean or absent.
Probed: a file there with an unused variable, a `debugger` and an `eval` drew **0 diagnostics at
`src` and 3 at `.`**. Every package lints `.` now. The formatter keeps explicit globs because
`oxfmt -c ../../oxfmt.json --check .` inside a NestJS service tries to format `README.md`, reaches
for `svelte/compiler` for its embedded code blocks and dies - installing svelte in a NestJS service
to format its README is not a trade worth making.

**`configVersion: 0` IS raised, on all six - and the first pass calling it impossible is the more
useful half of this entry (gap 9).** Six lockfiles carried it: Sky's and the four Canari services'
(the frontend was already at 1).

The wrong reasoning, recorded so it is not repeated: moving the field needs the file deleted and
reinstalled; **a `bun.lock` regenerated under bun 1.4.0 is written at `lockfileVersion: 2`**, which
Dependabot cannot read and which `Guard the bun lockfile version` in `code-analysis.yml` rejects;
`bun install --help` offers no version flag. Two measurements - an in-place install, which preserves,
and a 1.4.0 regeneration, which gives v2 - were taken as exhausting the space, and "never regenerate"
went into `durable-rules` as a property of the FORMAT. It is a property of the WRITER, and the writer
is choosable. **`bunx --bun bun@1.3.14 install` regenerates from nothing at `lockfileVersion: 1` with
`configVersion: 1`.** 1.3.14 is the bun Dependabot itself bundles, `MAX_SUPPORTED_LOCKFILE_VERSION`
1, which is why it writes what Dependabot can read. The technique was already documented in
MiGallery's own `CLAUDE.md` while this page said it could not exist.

**What it costs, measured, because a regeneration re-resolves the entire tree.** Sky moved 209
resolution lines - `@oxc-project/types` 0.144.0 -> 0.147.0, `@napi-rs/wasm-runtime` 1.1.5 -> 1.2.3,
the rolldown bindings 1.2.4 -> newer, `@csstools/css-color-parser` 4.2.0 -> 4.2.1. The four Canari
services mostly DEDUPLICATED, one copy surviving where two had stood: `ajv@8.20.0`, `picomatch@4.0.7`
and (chat-delivery only) `gaxios@7.1.3`, `gcp-metadata@8.1.4`, `google-logging-utils@1.2.0` all
disappear, and `prettier@3.9.6` leaves core-service entirely. bun 1.4.0 then accepts all five files
under `--frozen-lockfile` with **no changes**, so the two bun versions genuinely cohabit. Every gate
was re-run against the new files: Sky check 43/0 errors, 50/50 tests, build OK; the services lint,
format, `nest build` and 157 / 6 / 563 / 271 jest tests under node.

**One thing is unexplained and is not being dismissed.** On the first pass over the services,
social-service reported 2 suites failed / 553 tests where six later runs - three of them replaying
the exact `bun run build` then `npm test` sequence - give 34/34 and 563. Ten tests missing means two
suites that never LOADED, not two that disagreed. The failure text was not captured, so there is no
cause; runs since capture full output so the next occurrence is diagnosable.

**Was parked here as "NestJS 11 -> 12", and was TAKEN on 2026-08-31** - correctly parked, because
it was a framework major across four deployed services and not a dependency bump. `@nestjs/config`
4 -> 12, `@nestjs/schedule` 6 -> 12, `@nestjs/axios` 4 -> 12, `@nestjs/typeorm` 11 -> 12 and
`ioredis` 5 -> 6 all landed; `@types/uuid` was deleted rather than bumped, `uuid` 14 having shipped
its own types all along. The framework itself is on 12 in media and core and held at 11 in
chat-delivery and social by one upstream package. **State and reasoning live on
[nestjs-framework](services/nestjs-framework.md), the only copy** - do not restate them here, which
is what made this paragraph wrong twice about its neighbours.
