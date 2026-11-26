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
