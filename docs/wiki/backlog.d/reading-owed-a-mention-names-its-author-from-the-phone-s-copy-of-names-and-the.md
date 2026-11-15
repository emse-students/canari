## Reading owed - a mention names its author from the phone's copy of names, and the push sentences come from Rust in the app language

target: 1.7.0

**What is built:** a mention names its author from the phone's copy of names, and the push sentences come from Rust in the app language (WP-MENTION-NAME #2047, WP-PUSH-I18N #2037; [mobile](../frontend/mobile.md#a-mention-names-its-author-from-the-phones-own-copy-wp-mention-name-2026-10-18))

**The reading that closes it:** one mention push on each phone (app killed) with a known and an unknown author: the name, or "someone"; on the Mi 9T, whether the COLLAPSED shade shows only the author line. Dev sends push (Firebase secret set 2026-10-21, measured 2026-11-14), so read on a store tester build, which talks to dev

**iPhone 12 half, known author, read 2026-11-14 on dev (`1.6.12-alpha.2`, app killed):** a salon mention of gamma from delta ("nse banc communaute", "general"), sent from the delta web seat with a mention chip, raised the banner with the title "nse banc communaute - #general", the subtitle "Canari Test Delta vous a mentionne" and the body "@vous reading M mention" (`TIME SENSITIVE`, delta's face as the attachment), read from Notification Center with `ios.mjs nc` and `tree`. The phone names the author and the sentence is in French, the phone's app language. **Left: the unknown-author case ("someone") on the iPhone, and the whole Mi 9T half (including the collapsed shade).** The dev message was deleted.

**Triage 2026-11-14 - MERGED with "a salon banner names its SPEAKER"** (Android #2881, iOS NSE and `canari_push.mm` 2026-11-01; [mobile](../frontend/mobile.md#notification-service-extension-nse)): one salon banner on each phone (app killed, then backgrounded), from a member the app has named and one it has not: the name above the line and their initials, then "Quelqu'un" with a "?" and the `[SALON_AUTHOR]` line in the log; the iPhone known-author case was read on 2026-11-14 (title "nse banc communaute - #general", delta's face). **Left: the Mi 9T half of both (known and unknown author, the collapsed shade, the initials, the backgrounded run), about 20 min, and the iPhone unknown-author case ("someone" and the "?"), about 15 min.** An unknown author is staged with a web account the phone has never named (a fresh member added to the salon).

**Mi 9T, known author, READ 2026-11-15 on dev (`1.6.12-alpha.2`, build 100601202, the alpha account; beta mentioned alpha with a mention chip in the salon "général" of a bench community):**
- **Killed:** the native handler logged `notification posted showsMessage=true ... mentionsMe=true`.
  - The COLLAPSED shade showed ONLY the author line under the title: "mi9t banc S1 - #général", then "Canari Test Beta : @vous mention tue connu".
  - Expanded, it showed the salon title, then the speaker's name with beta's face, then "@vous mention tue connu", in French, the app's language.
  - Beta has a profile photo, so the face stands where the initials would.
- **Backgrounded:** the same notification (`android.title` "mi9t banc S1 - #général : Canari Test Beta", `conversationTitle` the salon, text "@vous mention arriere-plan connu").

**Left: on the Mi 9T, the unknown author ("Quelqu'un" with a "?", and the initials of a named author with no photo). This needs an account the phone has never named, which this sitting did not have. On the iPhone, the unknown-author case.**

**Triage 2026-11-15 - the unknown-author halves are DELETED (Mi 9T; the iPhone one is the same case).** The case needs a sender the phone has NEVER named, and the bench holds exactly four accounts, every one of them already named in this phone's copy (it holds a conversation with each). A v1 session, the other way to an unnamed speaker, is a state this bench cannot choose a salon for. The rule itself ("Quelqu'un" with a "?", no photo, the `[SALON_AUTHOR]` line) is pinned by `ChannelBannerAuthorTest` (a proven author the phone cannot name is unnamed, faceless and draws a question mark; a v1 session proves no author; a blank stored name is no name), and the named-author path is read on both phones. **What stays: nothing of the Mi 9T half.** The iPhone known-author half was read 2026-11-14.
