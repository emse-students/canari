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
