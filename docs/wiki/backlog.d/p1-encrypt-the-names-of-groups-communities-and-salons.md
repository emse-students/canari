## P1 - encrypt the names of groups, communities and salons (raised 2026-10-21, tied to principle 1 of the charter on 2026-11-10)

target: 1.8.0

Names are in the clear on the server: `dm_groups.name`, `channel_workspaces.name`, `channels.name` and
the community `slug` are plaintext columns, and push notifications carry sender and group names to
FCM and APNs ([dm-vs-community-encryption](../protocols/dm-vs-community-encryption.md#both)). The
owner raised encrypting them on 2026-10-21; it is not designed yet. Principle 1 of
[Nos principes](../../principes.md) ("Vos messages sont à vous", conversations, groups and communities
encrypted so that even Canari cannot read them) now makes it a debt against the charter, not a wish.

Constraints, from the page above:

- A name is read by the server today to list, search and route (a community directory, a slug in a
  URL, a push title). Each of those readers must be enumerated first, and each either moves to the
  client or loses the name.
- A name must be sealed under a key every member already holds (the MLS group secret for a group, the
  key group for a community), so a member who joins later reads it and one who leaves cannot read a
  rename.
- The push path names the group in clear text: it is closed by the content-free push chantier
  ([backlog](push-payloads-carry-nothing-for-google-and-apple.md)), which this work follows or ships with.
- Existing rows are migrated, not left plaintext beside ciphertext: a held migration with a rollback
  and a count of rows still readable by the server.

First step: the design, with the enumeration of every server-side reader of each name column.
