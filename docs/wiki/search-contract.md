# The search contract

**What every search box in the ecosystem promises, and the numbers behind it.** Five repositories,
six boxes, four independent implementations - written down here once so the next one does not have
to guess. This page is the contract; the inventory that found the divergence is
[ecosystem-convergence](ecosystem-convergence.md#1-tolerant-name-search---six-boxes-four-implementations-two-with-no-tolerance-at-all),
and it should not be restated here.

Written 2026-08-19, after measuring the ladders against the real roster rather than arguing about
them.

## The promise

A search box takes what a person typed, not what they meant to type. Three things follow, and they
are the whole contract:

1. **A typo still finds the person.** Case and accents are folded away before anything else; a
   single wrong keystroke - a swap, a missing letter, a wrong letter - still reaches the name.
2. **Word order is irrelevant.** "dupont marie" and "marie dupont" are the same query. This comes
   for free from matching token to token instead of query to string, and it is why nobody should
   implement it any other way.
3. **The answers are RANKED, not filtered.** Closest first. Any surface that truncates - a dropdown
   showing eight rows, an autocomplete showing five - throws away the best match as readily as the
   worst if it only filters, which makes ranking the part that is not optional.

And one rule that is easy to get backwards: **every typed word must match something**. A query is a
conjunction. Someone typing "jean dupont" is asking for the person who is both; returning every Jean
is a search that ignored half of what was typed.

## The ladder

> **OSA edit distance. Tolerance taken from the SHORTER of the two tokens: 0 up to 3 characters,
> 1 from 4 to 7, 2 from 8.**

- **OSA** is Levenshtein with the swap of two adjacent characters charged as ONE edit rather than
  two (optimal string alignment). It is not a refinement, it is the difference between finding
  "jaen" and not finding it.
- **From the shorter of the two tokens**, so a three-letter query cannot buy itself two edits
  against a nine-letter surname - at that ratio the tolerance matches most of a roster, which is the
  same as not filtering at all.
- The tolerance applies **inside the fuzzy tier only**. An exact word, a prefix and a substring are
  matched before it and are never charged an edit: somebody who typed "dupon" has not made a
  mistake, they have stopped typing.

### Why those numbers

Measured against Canari's production roster - **207 people, 376 distinct name tokens** - by taking
every token, making every single-keystroke fault a person actually makes (adjacent transposition,
deletion, substitution), and asking two questions of each ladder: does the typo still reach the name
it was made from, and **how many OTHER names does it now also reach**. The second is the one nobody
measures, and it is the one that decides.

| Ladder, as each repo actually implemented it | Typos recovered | Wrong names offered per query |
| --- | --- | --- |
| Sky - plain Levenshtein, tolerance from the QUERY token, `<=4:1` else `2` | 98.1% | **0.50** |
| MiGallery - same ladder, OSA | 100.0% | **0.53** |
| Le Cercle - OSA, tolerance from the shorter token, `<=3:0`, `<=6:1`, else `2` | 97.7% | 0.08 |
| **This contract** - OSA, shorter token, `<=3:0`, `<=7:1`, else `2` | 97.7% | **0.05** |

Three findings, in the order they matter:

- **OSA is free and Levenshtein is not.** Sky recovers a transposition on a five-letter name only by
  spending a tolerance of 2, which costs it 0.66 extra wrong names on that length; OSA recovers the
  same typo at a tolerance of 1, for 0.03. Same recall, twenty times the noise. A transposition is
  also the commonest typo there is, so this is not a corner.
- **A tolerance of 2 below eight characters buys no recall at all.** Every single-keystroke fault is
  one edit by construction, so the second edit recovers nothing that the first did not - at lengths
  5 and 6 the loose ladder and the tight one both recover 100%, and the loose one offers 0.95 and
  0.98 wrong names per query against 0.07. **Half the queries on the loose ladder put a wrong person
  in the list.** That is the whole case.
- **The 0 rung below four characters is a deliberate loss, and the only one.** It costs 18% of the
  recovery on four-letter names (a deletion turns one into a three-letter query, and three letters
  carry no information: at a tolerance of 1 they reach nearly one extra wrong name per query). It is
  survivable because a three-character query is almost always a PREFIX, and prefixes are matched by
  the substring tier before the fuzzy tier is ever reached.

**The `>=8 -> 2` rung is the one thing here the measurement does not justify.** Every fault tested
was a single keystroke, so a tolerance of 1 would have scored identically; the second edit is there
for a long name carrying two faults, and it is kept because at that length it is nearly free (0.02
wrong names per query). Said plainly rather than dressed up as a result.

### Re-measuring

The script is not kept - the ladder is, and re-deriving it takes ten minutes. What must be repeated
if the ladder is ever changed: run it **against the population it will actually run on**, not a word
list. A roster of French student names has a shape - shared prefixes, a handful of very common first
names - that a generic corpus does not, and the wrong-names-per-query figure is entirely a property
of that shape. Aggregates only; no name leaves the box it is measured on.

## Who implements it, and how

| Repo | Where | Medium |
| --- | --- | --- |
| **Canari** | `apps/core-service/src/users/userSearch.ts` | Postgres `word_similarity` (pg_trgm) + `unaccent` |
| **Sky** | `src/lib/utils/format.ts` `personMatchScore` | in-memory, TypeScript |
| **MiGallery** | `src/lib/fuzzy.ts` `fuzzyScore` / `fuzzySearch` | in-memory, TypeScript |
| **Le Cercle** | `src/lib/search/fuzzy.ts` `fuzzyScore` / `fuzzyRank` | in-memory, TypeScript |
| **Portail-etu** | `src/lib/search/fuzzy.ts` | in-memory, TypeScript |

**Canari's is a different medium, not a worse one.** Trigram similarity in the database is the only
one of the five that does not need the candidate set in the client, and it cannot be "aligned" with
the other four without ceasing to be that. What it keeps is the promise - typos, inversion, ranking
- and the ladder above does not apply to it, because a trigram overlap threshold is not an edit
count. If it ever has to be compared, the comparison is on the promise, not on the number.

**The convergence unit is this page, not a package.** Four independent implementations of the same
contract already exist and a fifth appeared while the inventory was being written, by somebody who
had not read any of it. A shared package would not have settled the ladder - each author would still
have picked their own numbers - and it would have coupled five deployments to one release. What was
missing was the number, written down once, with the measurement that produced it.

## Pinned by

Each repository owns a test that pins the ladder in its own code, because a contract nothing
executes is a comment:

- **Sky** - `src/lib/utils/format.test.ts`
- **MiGallery** - `tests/fuzzy.test.ts`
- **Le Cercle** - `src/lib/search/fuzzy.test.ts`
- **Portail-etu** - `tests/fuzzy.test.ts`

Each asserts the same three things: a transposition costs one edit, a token of 3 characters or fewer
tolerates none, and the rungs sit at 4 and 8.

## Related

- [ecosystem-convergence](ecosystem-convergence.md) - the seven-axis inventory this came out of
- [durable-rules](durable-rules.md) - the rules this page's findings became
