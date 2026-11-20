## CanaReels sent to community salons (RC-8): the salon send path and the salon rows of "Envoyer à..."

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Moved out of `1.7.0` by the owner on 2026-11-16
([decisions](owner-decisions-of-2026-11-16.md#decided-the-evening-of-2026-11-16)): the "Envoyer à..."
list can draw salon rows (the share picker's rows,
[reels-in-chat section 22](../frontend/modules/reels-in-chat.md#22-the-two-paths-owner-2026-11-16)),
but the reel sheet lists none and a salon's camera takes photos only until this ships
([2.3](../frontend/modules/reels-in-chat.md#23-salons), [15.4](../frontend/modules/reels-in-chat.md#154-a-moderators-delete-in-one-place-erases-the-file-everywhere)).

What it is:

- **The client salon send of a reel** (RC-8): a reel `MediaMsg` into a salon, the `chat-reel` class,
  the salon declaration RC-14 already accepts on the server.
- **The `channel_messages` `mediaId` migration**, already APPROVED by the owner (15.4, 2026-10-30): the
  salon row names its media so a purge can find it.
- **A moderator's delete purges through `chat-reel-purge`** with the ownership ALLOWLIST (only a media
  the deleted message names, under the class it was uploaded as), so one salon delete erases the file
  everywhere it was sent (D-oneblob).
- **The salon media-download access check**: a salon reel is served only to a member of that salon.
- **The salon rows in the sheet** (15.8): listed where the member holds `SEND_MESSAGES`, is not muted
  in the community and the salon is not read-only for them; `reelMessages = !isChannel` lifted for a
  salon that passes; the salon readings of 21.4 (a salon target, a salon moderator's purge read as a
  tombstone in a DM).
