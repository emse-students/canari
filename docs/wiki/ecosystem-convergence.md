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
word inversion and ranks by closeness**. Six boxes were found; two do none of it.

| Repo | Where | Method | Typos | Inversion | Ranked |
| --- | --- | --- | --- | --- | --- |
| **Canari** | `apps/core-service/src/users/userSearch.ts:50` | Postgres `word_similarity` (pg_trgm) + `unaccent`, per term, `search_score` column | trigram overlap | yes (per-term `AND`) | yes |
| **Sky** | `src/lib/utils/format.ts:150` `personMatchScore` | in-memory, token-to-token, **plain Levenshtein**, tolerance 1 (<=4 chars) / 2 | yes | yes | yes |
| **MiGallery** | `src/lib/fuzzy.ts` `fuzzyScore` | in-memory, token-to-token, **Damerau-Levenshtein (OSA)**, same tolerance ladder | yes | yes | yes |
| **Portail-etu** | `src/routes/associations/+page.svelte:18` | `name.toLowerCase().includes(query)` | **no** | **no** | **no** |
| **Le Cercle** | `src/lib/server/db/users/index.ts:42` `searchUsers` | SQL `WHERE (first_name \|\| ' ' \|\| last_name) LIKE '%q%'`, `ORDER BY promo DESC`, `LIMIT 10` | **no** | **no** | **no** - ordered by promo |

Three findings, in order of how much they cost:

- **Le Cercle's is the worst and the most exposed.** It is the till's user picker: an operator types
  a name at a counter with a queue behind them. It cannot match "Dupond Jean" against "Jean Dupont",
  a single typo returns nothing, and the ten rows it does return are the ten most recent promos
  rather than the ten closest - so a correct query can push the right person off the end.
- **Portail-etu's association filter** is plain substring over name and description. Lower stakes
  (an association list is short and visible) but it is the same gap.
- **Sky and MiGallery are the same algorithm one metric apart.** Both do token-to-token matching with
  a tolerance of 1 for tokens of 4 characters or fewer and 2 above; MiGallery counts a transposition
  as ONE edit and Sky as two, so `jaen` finds `Jean` in the gallery and nowhere else. This is the
  divergence already recorded in `CLAUDE.md`; it is now located precisely.

**Canari's is a different kind of thing, not a better or worse one.** Trigram similarity in the
database scales to a table nobody wants to load into memory, and it is the only one of the five that
does not require the candidate set to be in the client. It cannot be "aligned" with the other two
without changing what it is; what CAN be aligned is the promise - typos, inversion, ranking - and
Canari keeps it.

**The convergence unit here is the CONTRACT, not the code**: a documented tolerance ladder, a
documented "every query token must match something" rule, and a documented ordering. Three of the
six already implement it; one implements it in a different medium; two implement nothing.

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
| **MiGallery** | prettier | **no** - husky pre-commit and `npm run validate` only | yes | yes |
| **Le Cercle** | prettier (inside `lint`) | via `lint`, **if the pipeline runs** | via the pipeline | **inert** - `.gitlab-ci.yml` creates no pipeline until `CERCLE_CI_ENABLED` is set |

Two findings:

- **Le Cercle has no running CI.** Its `.gitlab-ci.yml` is deliberately inert - it arrived as a
  proposal and switching it on needs variables somebody has to set. Until then its only gate is the
  husky pre-commit, which a `--no-verify` skips and which never runs on a merge request.
- **MiGallery's formatting is enforced only by a hook.** Sky was in exactly this state and three
  files had drifted out of shape with no red run to show for it.

## 7. Line endings

`.gitattributes` pinning the working tree to LF: **Canari yes, Sky yes (added 2026-08-19), Le Cercle
yes, MiGallery no, Portail-etu no.**

Without it, a checkout on Windows (`core.autocrlf=true`) materialises CRLF while prettier - which
has no `endOfLine` override in any of these repos, so it defaults to `lf` - insists on LF. The
result is a repository whose own `format:check` cannot pass on Windows and passes on Linux: **a gate
that reports the operating system rather than the code.** Sky's did exactly that; MiGallery's and
Portail-etu's would, the moment anyone ran `format:check` there on this machine.

---

## What the inventory says, in one paragraph

The values are already unanimous wherever anyone bothered to state one - 4 seconds for an outbound
call, the same tolerance ladder for a typo, the same head. **What differs is whether a repository
states it at all**, and the gaps cluster in the two repositories nobody has been through recently:
MiGallery (no outbound deadline, no formatting gate in CI, no `.gitattributes`) and Le Cercle (no
tolerant search, no running CI). Neither gap is a disagreement about the right answer. That is the
argument against a shared package and for a written contract: there is nothing to reconcile, only
things to finish.

## Related

- [frontend/seo.md](frontend/seo.md) - the worked example of one method in four repositories
- [durable-rules.md](durable-rules.md) - the rules these divergences were measured against
- [backlog.md](backlog.md) - where anything this page turns into work is scheduled
