## Reading owed - the post search filters by person and by association (owner, 2026-11-19)

target: 1.8.2

Built 2026-11-26 (`feat/post-search-filters`): `GET /api/posts/search` takes `authorId` and `associationId`
beside the words, the page draws two filter buttons under the search field, each becoming a removable chip
([posts](../frontend/modules/posts.md#the-search-stops-where-the-feed-stops-2026-10-04)). The filter is one
more `AND` beside the feed's own audience clauses, so it narrows and never widens; a person is their personal,
non-anonymous posts. It serves the product principle of 2026-11-10
([engagement](../engagement.md#the-product-principle-owner-2026-11-10)).

**Still owed:** the query measured on the dev copy of production (the host being shared; both columns are
indexed), and an integration run of `institution-reach.integration.spec.ts`-style cases with a filter against a
real PostgreSQL (the unit spec asserts the SQL text only).

**The reading, on a phone** on the first pre-release carrying it: search with a person alone, an association
alone, each with a word, and both together; remove each chip. **Passes when** every result is a post the
reader sees in the feed, a person never lists an association's post, and the chips clear the filter.

**Read on the Mi 9T, 1.8.2-alpha.7 (2026-11-26):** the association filter PASSES (chip, narrowing, clear). DEFECT (P3, cosmetic): in the search field the magnifier icon and the clear button sit at the wrong height, floating below the field over the picker list. The person filter is still unread.

**Read on the Mi 9T, `1.8.2-alpha.8` (2026-11-26, [sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha8-mi-9t-the-v22-store-upgraded-a-picked-file-sent-the-person-filter-tous-in-a-salon)): the phone reading PASSES whole.** A person alone lists only that person's personal posts (none of the posts they wrote as an association), a word narrows it, a person and an association together list nothing, and each chip removed widens the result back. **Still owed:** the dev measurement and the PostgreSQL run above, and the P3 icon defect, which on `alpha.8` also sets the association field's magnifier over the typed text.

**The P3 icon defect is fixed structurally in `1.8.4`** by [the universal search](universal-search.md), which replaces this field: its magnifier is placed on the input's own wrapper and the filters sit under the Posts chip, not under the field. Nothing more is owed for it here.
