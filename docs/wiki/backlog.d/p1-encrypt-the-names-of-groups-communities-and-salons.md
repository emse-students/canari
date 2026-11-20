## P1 - encrypt the names of groups, communities and salons (raised 2026-10-21, tied to principle 1 of the charter on 2026-11-10)

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

**2026-11-17 evening: step 1 shipped in `1.7.0` (#3785, on dev from `1.7.0-alpha.10`); steps 2-4 are `1.7.1`, per the [scope cut](owner-decisions-of-2026-11-17.md#the-170-scope-cut-afternoon---it-supersedes-the-mornings-line-below).**

Names are in the clear on the server: `dm_groups.name`, `channel_workspaces.name` and `slug`, and
`channels.name` are plaintext columns. Push notifications carry sender and group names to FCM and APNs
([dm-vs-community-encryption](../protocols/dm-vs-community-encryption.md#both)). Principle 1 of
[Nos principes](../../principes.md) makes this a debt against the charter. The owner placed it after
the content-free push and the encrypted photos: step 6 is group names, step 7 is a sealed community
state ([decisions of 2026-11-14](owner-decisions-of-2026-11-14.md)). This entry absorbs the P3
"names in the clear" entry of 2026-10-21. Its constraints (invite preview, slug, native push, admin
screens) are answered on the design page.

**Designed and started on 2026-11-17: [sealed-names](../protocols/sealed-names.md).** That page lists
every server-side reader of each column, and says whether each one moves to the device or loses the
name. The design treats a name as group state carried by MLS: each name is dated by the server's
acceptance of its frame, and the inviter's join push hands it to a newcomer.

- **Step 1 - BUILT (2026-11-17):** the device dates a group's name, and the members' frames, not the
  server's list, are the authority. This also fixes an older rename overwriting a newer one. No
  migration. No phone reading is owed, because the unit tests read it deterministically.
- **Left, in order:**
  1. Every group gets a dated name: creation and a one-time silent restatement. About 2 days.
  2. The server stops knowing group names: create and rename, the push fields, the join-ask push, the
     native naming, the invite preview (the name moves to the link's `#fragment`). It ships behind the
     minimum version decided below. About 1 week.
  3. A HELD migration nulls `dm_groups.name`, with a before and after count. About 1 day plus the
     owner's line.
  4. The sealed community state: name, photo, salons, role labels and nicknames under a key-group key.
     The slug goes, and the migration is held. 2 to 4 weeks.
- **Owner decisions taken (2026-11-17)**, on the page:
  - A shared invite link carries the name in its `#fragment`, never sent to a server. The in-app card
    shows it, and a link unfurler shows a generic "Invitation Canari".
  - The minimum client version for step 2 is the version carrying step 1 and the creation dating.

Push names are closed by [content-free push](push-payloads-carry-nothing-for-google-and-apple.md),
which this work follows.
