## The universal search - one bar for the whole app (owner, 2026-11-26)

target: 1.8.4

*Built 2026-11-26 on `feat/universal-search` ([design](../frontend/universal-search.md), [decisions](../decisions/owner-decisions-of-2026-11-26.md), item 6).* ONE search on the home page, in place of the post search field, opened on a phone by the header's magnifier from every tab: eight sections (Personnes, Discussions, Communautés, Associations, Posts, Événements, Formulaires, Paramètres), the top 3 of each with "Tout afficher", a chip per section, and the `1.8.2` person and association filters inside Posts. Messages are searched on the device only, through an index held in memory and dropped on close and at sign-out (charter principle 1). It supersedes the 2026-11-25 entry for one global search bar, whose constraint it honours.

**Still owed before it closes:**

- **Post comments and booking rooms**, in the owner's 2026-11-25 list but not in the 2026-11-26 sections: a server search over comments under the post's audience predicate, and the bookings space list as a provider.
- **A message hit opens its conversation, not the message**: wire the in-conversation jump from the result.

**The reading, on both bench phones** on the first pre-release carrying it: open the search from the magnifier on each tab; search a person, a conversation by name, a word of a message (with and without its accent), a community, an association, a post with each filter, an event, a form and a setting; tap one row of each; close and reopen; sign out and back in as another test account and search the first account's word. **Passes when** every section answers, each row opens its object, no message word appears in the network log (only People and Posts send the query), the second account finds none of the first account's messages, and the first pass over the Mi 9T's store is timed in the in-app log (`[SEARCH] local index: N/N conversation(s) read in T ms`) - that duration is the phone number the [design](../frontend/universal-search.md#the-local-message-index) owes. While it runs, the conversation names must show at once and the Discussions section must say "Lecture des messages de l'appareil..." until the message matches arrive; if the pass is too slow to bear, [the sealed snapshot](universal-search-sealed-index-snapshot.md) is the next step.
