## P3 - one global search bar, beside or instead of the posts search

target: 1.9.0

*2026-11-25: asked by the owner from feedback he received ([decisions](../decisions/owner-decisions-of-2026-11-25.md), item 4).* People want ONE search across:

- posts: the author's identity, the post's content AND its comments;
- conversations and groups;
- users (replacing the directory);
- booking rooms;
- the rest of the app's objects.

Whether it complements or replaces the posts search bar is open: the owner discusses the design when `1.9.0` starts, and nothing is decided beyond this scope.

**The constraint the design must honour** (charter principle 1, your messages are yours, [principes](../../principes.md)): conversations and messages are end-to-end encrypted, so their search can only run ON THE DEVICE over what it holds (the local store), never on the server. Posts, users and rooms are server-side and already have their own routes. Starting points: [the search contract](../search-contract.md), [the post search filters](post-search-filters-by-person-and-by-association.md), [the bookings chantier](../bookings-chantier.md).
