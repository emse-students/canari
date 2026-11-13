## P3 - Names in the clear: conversation, community and salon names (user, 2026-10-21, not designed)

target: 1.9.0

`dm_groups.name`, `channel_workspaces.name` and `slug`, and `channels.name` are plaintext, and pushes
carry sender and group names in the clear to FCM and APNs ([DSO dossier](../compliance/dso-dossier.md)).
The user wants them encrypted "later". Constraints to design against before anything is built: an
invite link's preview shows the community name to a non-member; the `slug` is a unique public
identifier; a push decrypted natively needs the name key on the device before any WebView runs (the
native mirror path, [channel-encryption §4.9](../protocols/channel-encryption.md#49-notifications-keep-working-and-the-mirror-gets-a-bound));
server-side admin and moderation screens list communities by name.
