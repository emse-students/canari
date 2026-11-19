## The post search filters by person and by association (owner, 2026-11-19)

target: 1.8.0

**Asked by the owner on 2026-11-19, in place of the global search.** He did not see what a global
search would be for; what he wants is a better POST search: *"filtrer les posts d'une personne, ou
d'une asso"* ([decisions](owner-decisions-of-2026-11-19.md)). The global-search entry is deleted.

It serves the product principle of 2026-11-10 - a reader finds their information fast
([engagement](../engagement.md#the-product-principle-owner-2026-11-10)).

**What it is:** the existing post search gains two filters, an author (a person) and an association,
combinable with the text. Each reads only what the reader may already see (the audience rules are
unchanged: a filter narrows, it never widens). User strings in Paraglide.

**Owed (design, then build):** where the two filters sit in the current search screen; the server
query and its index (measured on the dev copy of production first, the host being shared); the
integration spec proving a filter never returns a post outside the reader's audience.

**Closed when** both filters, alone and together with text, are read on a phone on a pre-release.
