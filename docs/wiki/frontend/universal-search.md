# The universal search (owner, 2026-11-26; `1.8.4`)

> *"ce truc est vraiment nul et à reformer. Je veux UNE seule barre de recherche pour toute
> l'application"* - the owner, 2026-11-26. The model is LinkedIn's search page: one field, the
> results grouped by kind, the top of each kind first, and a chip per kind to narrow to it.

ONE search replaces the post search field and the chat sidebar's conversation filter. It answers
eight sections from one query. Where each section answers is chosen by one rule: **what the device
already holds is searched on the device** (owner: *"je veux que tout se fasse localement"*), and
only what it does not hold goes to the server.

Code: `frontend/src/lib/search/` (the types, the ranking, the providers, the local message index, the
state) and `frontend/src/lib/components/search/` (the page). The decisions of the day are item 6 of
[the owner's decisions of 2026-11-26](../decisions/owner-decisions-of-2026-11-26.md).

## Where it sits

- **On the home page (`/posts`), in place of the old post search field.** Focusing it, or typing
  into it, replaces the feed with the results; closing it (the cross, or Escape on an empty field)
  gives the feed back where it was.
- **On a phone, the header's magnifier opens the same search** from every tab (it was on `/posts`
  only). It links `/posts?search=1`, the command the feed already strips before acting
  ([posts](modules/posts.md#the-headers-publish-and-search-are-commands-stripped-before-they-act-2026-10-28)).
  The `+` and the bell stay on the home tab only.
- **On a desktop, the chat sidebar's filter is gone**; its header carries a magnifier that links
  the same page. `/` or Ctrl/Cmd+K focuses the field from anywhere on the home page.
- **`/posts?q=words` opens it prefilled** - the URL the SEO `SearchAction` already advertises, so a
  search engine's sitelinks box lands on a real search instead of a feed.

## The sections, their sources, and their ranking

| Section | Source | Answered by | Ranking inside the section |
| --- | --- | --- | --- |
| Personnes | **server** | `GET /api/users/search` (the directory's trigram search, [search-contract](../search-contract.md)) | the server's own: trigram similarity |
| Discussions | **device** | the stored conversation rows + the live map (`heldConversations.ts`), and the local message index | names first (tiers below, then the most recent), then the messages holding every word, newest first |
| Communautés | **device** | the communities and salons the sidebar already holds (`hasAccess === false` skipped) | tiers, then the sidebar's order |
| Associations | **list** | the directory list the Associations page reads | tiers, then the directory's order |
| Posts | **server** | `GET /api/posts/search`, with its two filters | the server's own: newest first |
| Événements | **list** | the agenda the calendar reads, over 90 days back and 365 ahead (breaks skipped) | tiers, then upcoming soonest first, then past latest first |
| Formulaires | **list** | the forms the reader manages (`/forms`) | tiers, then the most recently updated |
| Paramètres | **device** | a static index built from the settings page's own control labels (`settingsSearchIndex()`) | tiers, then the page's order |

**The three sources are said on the page**, under each section heading ("Cherché sur cet appareil :
rien n'est envoyé.", "Liste lue une fois, filtrée sur cet appareil : vos mots ne sont pas envoyés.",
"Cherché par le serveur de Canari."), because principle 1 is a
promise a reader should be able to check:

- **device**: matched over what the device holds; the query never leaves it.
- **list**: the server sends the same list its own page reads, ONCE per opening of the search, and
  the matching runs on the device. The server learns that the list was read, never what was typed.
- **server**: the words are sent, and the server answers the matches. Only People and Posts are
  here, because the device does not hold the directory nor the posts it has not loaded.

**The tiers** are one implementation (`search/rank.ts`), so two sections never disagree about what
"matches" means: 0 the whole label is the query, 1 the label starts with it, 2 every typed word
starts a word of the label, 3 every typed word is inside it, 4 every typed word is within the
contract's typo tolerance of a word (OSA, from the shorter token, `utils/tolerantSearch.ts`: 0 up to 3 characters, 1 from 4 to
7, 2 from 8 - [search-contract](../search-contract.md#the-ladder)). Folding is `foldForSearch` on both
sides. **Inside a tier the caller's order is kept** (a stable sort), so every ranking reads in one
sentence: "best match first, then the most recent" (principle 3, no opaque ranking).

**Messages have no typo tier**: a message is prose, and a tolerance over every word of every message
would offer a wrong hit for most short queries. Every typed word must be a substring of the message.

## The overview, the chips, "Tout afficher"

- **The overview** shows the top 3 of every section (`OVERVIEW_LIMIT`), each with its count and a
  "Tout afficher (N)" button when there are more. A section with no match is not drawn; a section
  that failed says so in its own place (a provider throws, it never answers an empty list for a
  failure) and the others are not affected.
- **A chip per section**, plus "Tout". A chip shows that section alone, 30 rows at a time
  (`SECTION_PAGE`), with "Afficher plus". "Tout afficher" is the same as tapping that chip.
- **Inside the Posts chip, "Personne" and "Association" are filters** - the `1.8.2` post filters
  (`PostSearchFilters.svelte`), unchanged: a person or an association alone, each with words, both
  together, each a removable chip. A filter set with no words still searches (the endpoint takes an
  empty `q` when a filter is given).
- **Inside the People chip**, a link opens the directory with the same words (`/directory?q=`),
  which keeps the promo, programme and campus filters the search does not repeat.
- Opening a row: a person, an association or a form is a link; a conversation opens the chat on it
  (`requestConversationOpening`), a salon opens through `openChannelConversation`, an event opens
  the calendar's own detail sheet, a post is the feed's own card (`guardedCard`), so it reacts,
  comments and opens CanaReels exactly as in the feed.

## Pacing, and which answer wins

Device and list sections answer at every keystroke: there is no request to pace. **Server sections
wait for a pause of 400 ms in typing** (`SERVER_PACE_MS`); that pause decides only WHEN a request
leaves, never what is shown. What is shown is decided by an epoch per section: every query bumps it,
and an answer whose epoch is not the latest is dropped. So a slow answer to an old query can never
overwrite the answer to a newer one, whatever the network does. A query shorter than 2 characters
asks nothing (`MIN_QUERY_LENGTH`).

## The local message index

**What it holds.** The searchable words of every message of the direct and group conversations the
device stores: a text, a media's caption, a poll's question. Not a deleted message, not a notice the
app draws ("X a ajouté Y"), not a media without a caption. Salons are not stored on the device
([community-open-budget](community-open-budget.md)), so a salon is found by its name in Communautés,
and its history by the in-conversation search.

**Built by reading the store through its own decrypting reads** (`IStorage.getMessages`), one
conversation at a time, most recent first, yielding to the main thread between conversations
(`yieldToMainThread`). The result lives in MEMORY ONLY. **It is never written to disk**: the store is
sealed at rest with the device key, and a plaintext index beside it would undo that seal for every
word of every conversation.

**Kept true without a clock.** Every message write of the store crosses one seam,
`observeMessageWrites` (`db/messageWrites.ts`), a proxy that `getStorage` puts under the device-key
gate on both backends. `MESSAGE_WRITES` names, per write method, the conversations it touches
(`'all'` for a clear, a retention sweep or a re-seal); every other `IStorage` member is listed in
`NOT_A_MESSAGE_WRITE`, and `messageWrites.test.ts` parses the interface and fails on a member in
neither list, so a new write cannot bypass the index unseen. A write marks its conversations dirty
and tells the search, which re-runs Discussions; the next refresh re-reads ONLY the dirty
conversations. The dirty mark is cleared BEFORE a read, so a write landing during it is read by the
next pass. A refresh is single-flight: a second caller joins the pass under way.

**Its lifetime.** ONE index per realm (`localIndexRegistry.ts`). Opened, and warmed, when the search
opens; **discarded when the search closes, and at every sign-out** - `clearAuth` and
`clearAuthLocally` both call `discardLocalMessageIndex('signed out')` (`auth.searchIndex.test.ts`),
so the account signed in next can never search the messages of the one that left. A discarded index
answers nothing and stops listening.

**What it costs, measured.** 50,000 messages sealed with AES-GCM, read back on a desktop under bun
(2026-11-26): **6.5 s** of decrypting (one AES-GCM per message, the same per-message cost the store
pays on every read of a conversation), **17 ms** of folding, **13 ms of scanning per query**, and
about **16 MB** of text held. The first pass is linear in the messages held and is paid once per
opening of the search; after it, a query is a scan, and a write costs a re-read of its conversation
alone. Nothing in the pass depends on a clock: it ends when its list of conversations ends, at any
size, and a conversation of any length is one read. **A phone is slower, and that number is owed**
by the reading below. While the first pass runs, the Discussions section shows its skeleton.

**Its one limit, on the web: one tab.** The seam sees the writes of its own realm. A message written
by ANOTHER tab of the same browser (two tabs open on the chat) is not noted until the search is
closed and reopened. A phone has one realm, so this is a web-only gap; closing it would mean a
`BroadcastChannel` from the store's writers, which no other part of the app needs today.

## Privacy (charter principle 1, *vos messages sont à vous*)

- **A message match never leaves the device**: the words typed into Discussions, the conversations
  read and the messages found are never sent anywhere - not to the server, not into a log (the index
  logs counts and durations, never a word, a name or a message).
- The words typed are sent ONLY for People and Posts, both said "Cherché par le serveur de Canari." on the
  page, both of which were already server searches before this change.
- The decrypted index is never persisted, and is gone at sign-out.

## Accessibility and the keyboard (desktop)

- The field sits in a `role="search"` landmark and has a label; the results are one
  `aria-live="polite"` region with `aria-busy` while sections are answering; each section is a
  headed `<section>`, and the chips are a `role="group"` of toggle buttons (`aria-pressed`).
- **Enter** submits (asks the server sections at once, without the pause); **Escape** clears the
  field, then on an empty field closes the search; **ArrowDown** from the field goes to the first
  result; **ArrowUp/ArrowDown** move between results (a roving focus); ArrowUp from the first result
  returns to the field; **`/` and Ctrl/Cmd+K** focus the field.
- A matched word in a message is marked with `<mark>`, the offsets mapped back through
  `foldWithIndex`, so an accent before a match never shifts the highlight.

## What replaced what

**Removed (each was a duplicate of this search):**

- the post search field of `/posts`, its state and its result list - replaced by this page, whose
  Posts section is the same endpoint with the same two filters;
- the chat sidebar's conversation filter (`conversationMatchesQuery`,
  `selfConversationMatchesQuery`) - replaced by Discussions, which also searches the messages;
- the strings only they used (`chat_search_placeholder`, `posts_search_placeholder`,
  `posts_no_results`, `posts_no_results_filtered`).

**Kept, each with a job of its own** (a scoped search is not a duplicate when it does something the
universal one cannot):

- the in-conversation search: one thread, jumping between hits inside it, and a salon's history the
  device does not store;
- the GIF and emoji pickers (they search a catalogue, not the app's objects);
- `UserAutocomplete` and the member pickers (they PICK a person for an action, they do not navigate);
- the share, forward and republish pickers (they pick destinations);
- the bookings space list, the form responses panel and the cotisations roster (each filters one
  table of one page);
- the admin pages (their own scopes and permissions);
- the directory, which becomes the People section's refinement page (`/directory?q=`) and keeps its
  promo, programme and campus filters.

A side effect: the `1.8.2` P3 defect of the post search (the magnifier and the clear button at the
wrong height beside the filters) is gone structurally, because the icon is positioned on the input's
own wrapper and the filters now live under the chips, not under the field.

## What is left

- **Post comments and booking rooms** were in the owner's 2026-11-25 wish list
  ([decisions](../decisions/owner-decisions-of-2026-11-25.md)) and are not in the 2026-11-26 section
  list. Comments need a server search over comments under the post's audience predicate; rooms need
  the bookings chantier's space list as a provider.
- **Opening a message hit opens its conversation, not the message**: the jump to that message (the
  in-conversation search's `jumpToMessage`) is not wired from here.
- **Discussions waits for the first pass** before showing even its name hits; answering the names
  first and the messages when the pass ends would show the first rows sooner on a large store.
- **The phone reading**: on [the entry](../backlog.d/universal-search.md) (a reading may only target the earliest tier, so it lives in the `1.8.4` entry itself).
