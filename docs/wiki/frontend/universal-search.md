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
  search engine's sitelinks box lands on a real search instead of a feed. The effect that hands the
  words over tracks `initialQuery` ALONE (`untrack` around the run): it used to track the search's own
  state, so every answer that landed re-ran it and asked every section again, the server ones
  included, for as long as the page stayed open (`UniversalSearch.initialQuery.svelte.test.ts`).

## The sections, their sources, and their ranking

| Section | Source | Answered by | Ranking inside the section |
| --- | --- | --- | --- |
| Personnes | **server** | `GET /api/users/directory?q=` (the directory's trigram search, [search-contract](../search-contract.md)) | the server's own: trigram similarity |
| Discussions | **device** | the stored conversation rows + the live map (`heldConversations.ts`), and the local message index | names first (tiers below, then the most recent), then the messages holding every word, newest first |
| Communautés | **device** | the communities and salons the sidebar already holds (`hasAccess === false` skipped) | tiers, then the sidebar's order |
| Associations | **list** | the directory list the Associations page reads | tiers, then the directory's order |
| Posts | **server** | `GET /api/posts/search`, with its two filters | the server's own: newest first |
| Événements | **list** | the agenda the calendar reads, over 90 days back and 365 ahead (breaks skipped) | tiers, then upcoming soonest first, then past latest first |
| Formulaires | **list** | the forms the reader manages (`/forms`) | tiers, then the most recently updated |
| Paramètres | **device** | a static index built from the settings page's own control labels (`settingsSearchIndex()`) | tiers, then the page's order |

**The three sources are said on the page**, beside each section heading, because principle 1 is a
promise a reader should be able to check. A phone line is short, so the heading carries an icon and a
short label (a phone "Sur l'appareil", a filter "Filtré ici", a cloud "Serveur Canari"), and the whole
sentence ("Cherché sur cet appareil : rien n'est envoyé.", "Liste lue une fois, filtrée sur cet
appareil : vos mots ne sont pas envoyés.", "Cherché par le serveur de Canari.") is the label's tooltip
and what a screen reader says (review of 2026-11-27: the sentence wrapped into three lines on a
phone):

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

- **Every row has one shape**, whatever its section (`SearchHitRow`): a face or a logo or the
  section's icon, the title, the words around the match with the typed words marked, a grey line, and
  for a post its first picture at the end. **A post in the overview is such a row**
  (`postSearchHit`): who published it (`postAuthorName`, its face, its association's logo, or no face
  for "Anonyme"), the words around the match, when it was published, and its first picture as the
  ThumbHash the post already carries - painted from the post itself, so the row fetches nothing. It
  opens the post's page. The Posts chip draws the feed's own cards (review of 2026-11-27: the overview
  drew bare text).
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
(`yieldToMainThread`). Inside one conversation the read is one `SELECT` and one awaited AES-GCM
decrypt per row, so even a single conversation of 50,000 messages never holds the main thread for
one long frame. The result lives in MEMORY ONLY - see [why not on disk](#why-in-memory-and-not-on-disk-the-evidence).

**It answers while it fills** (review of 2026-11-27; it used to make Discussions wait for the
first pass, names included). The Discussions provider NEVER awaits the index: the conversation names
answer at once, the index answers what it holds now, and the answer carries `partial: true` while
the index is `filling` (no pass yet, a pass under way, or a write not read yet). The page then draws
"Lecture des messages de l'appareil..." under the rows instead of "Aucun résultat", and never says
"nothing found" for a partial section. The index tells the search again after 1, 2, 4, 8...
conversations read and once its passes end, so a store of N conversations costs O(log N) re-runs of
the section, with no clock. An answer given while the index was filling is owed that last word even
when the pass changed nothing (`answeredWhileFilling`), and an answer given once it is full is owed
none - which is what keeps the re-run from looping.

**Kept true without a clock, at the cost of the rows written.** Every message write of the store
crosses one seam, `observeMessageWrites` (`db/messageWrites.ts`), a proxy that `getStorage` puts
under the device-key gate on both backends. `MESSAGE_WRITES` names, per write method, the
conversations AND the message ids it touches (`{ conversationId, ids }`; `ids: 'all'` when a
conversation's rows are all dropped; `'all'` for a clear, a retention sweep or a re-seal); every other
`IStorage` member is listed in `NOT_A_MESSAGE_WRITE`, and `messageWrites.test.ts` parses the
interface and fails on a member in neither list, so a new write cannot bypass the index unseen. A
write starts the pass that reads it, and that pass re-reads ONLY the rows named
(`IStorage.getMessagesByIds`): an id the store no longer answers was deleted or moved away and is
forgotten, so **a message deleted or retracted after it was indexed is never shown**. Before this, a
write re-read its whole conversation: one new message in a 50,000-message group cost the whole
group's decrypt again, at every message, for as long as the search stayed open. A write landing
during a pass is read by the next one; the passes loop until one meets no new write - work
proportional to the writes. A conversation whose read FAILS is searched by none of its messages (not
by rows a write may have deleted meanwhile), logged, and re-read by the next pass a write starts; it
does not keep the index "filling", so a failing conversation cannot loop the passes.

**Retention.** `deleteOldMessages` names no rows, so it answers `'all'` and the next pass reads the
store again from scratch: correct, and paid once per sweep while a search is open. The device's
window is 5 years on the apps and 90 days in a browser (`deviceWindowMs()`).

**Its lifetime, and whose it is.** ONE index per realm (`localIndexRegistry.ts`), registered FOR AN
ACCOUNT: `openLocalMessageIndex(owner, ...)` discards an index held for another account rather than
hand it over, and the wiring answers no index once the signed-in account is not the one that opened
the search. Opened, and warmed, when the search opens; **discarded when the search closes, and at
every sign-out** - `clearAuth` and `clearAuthLocally` both call `discardLocalMessageIndex('signed out')`
(`auth.searchIndex.test.ts`). So the account signed in next can never search the messages of the one
that left, whether the switch went through a sign-out or not. A discarded index answers nothing and
stops listening.

**What it costs, measured.** 50,000 messages sealed with AES-GCM, read back on a desktop under bun
(2026-11-26): **6.5 s** of decrypting (one AES-GCM per message, the same per-message cost the store
pays on every read of a conversation), **17 ms** of folding, **13 ms of scanning per query**, and
about **16 MB** of text held. The first pass is linear in the messages held and is paid once per
opening of the search, in the background: the names and every other section answer during it, and
the messages arrive as it fills. After it, a query is a scan, and a write costs its own rows. **A
phone is slower, and that number is owed** by the reading of [the entry](../backlog.d/universal-search.md);
if it is too slow on the Mi 9T, [the sealed snapshot](../backlog.d/universal-search-sealed-index-snapshot.md)
is the measured next step.

### Why in memory and not on disk: the evidence

The question (review of 2026-11-27): if the whole database were encrypted at rest, a full-text index
inside it (SQLite FTS5 on the apps) would be equally protected and would remove the rebuild.

**The database is NOT encrypted as a whole; the app seals each row.** Read in the code:

- `db/types.ts`, `EncryptedMessageRow`: *"The content field of StoredMessage is never stored in
  plaintext - only this encrypted form exists on disk"*. Each row carries its own 12-byte IV and an
  AES-256-GCM `cipher_text` under the device key; `id`, `conversation_id`, `timestamp` and the order
  key are CLEAR columns (pagination and retention read them).
- `db/sqlite.ts` opens a plain SQLite file through the Tauri SQL plugin (no SQLCipher, no `PRAGMA
  key`) and encrypts in `saveMessages` (`encryptData(toMessagePayload(msg), deviceKeyB64)`) and
  decrypts in every read. The conversations table is plaintext metadata. IndexedDB on the web is the
  same shape (`db/indexeddb.ts`).
- The device key itself is the `SealedStore` key (`messages`, `graine`, `outbox`), re-sealed by
  `swapSealedPayloads` on a key change.

So an FTS5 table (or any token table) written beside `messages` would store every word of every
conversation in clear in a file that today holds only ciphertext - it would undo the seal, and charter
principle 1 refuses it. A keyed-hash token index (HMAC of each word under a key derived from the
device key) would hide the words but leak their frequencies and co-occurrences, and still needs a
substring-capable scheme the search contract relies on; it is not equivalent either. **The in-memory
index is the right design for this store.** If the rebuild is measured too slow on a phone, the step
that keeps the seal is to persist the index SEALED - one AES-GCM blob per conversation under the
device key - so a reopening costs one decrypt per conversation instead of one per message
([backlog](../backlog.d/universal-search-sealed-index-snapshot.md)).

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
- The decrypted index is never persisted, and is gone at sign-out and at any account change.
- **A message row shows its conversation's face, never its sender's**: a sender's face is a request
  for that member's avatar and name, which would tell the server which members wrote the messages that
  matched. The conversation's face is one the chat list already loaded; a group shows the section's
  icon.
- Checked fetch by fetch (review of 2026-11-27): Discussions, Communautés and Paramètres make no
  request; Associations, Événements and Formulaires make one each per opening, carrying no word
  (`listAssociationDirectory()`, `listAggregatedCalendarFeed(window)`, `getForms()`); only Personnes
  (`/api/users/directory?q=`) and Posts (`/api/posts/search`) carry the words.

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
- **The phone reading**: on [the entry](../backlog.d/universal-search.md) (a reading may only target the earliest tier, so it lives in the `1.8.4` entry itself).
