## A push raised while the app is dead titles an unnamed group by its members' first names (owner, 2026-11-17)

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**The owner, the evening of 2026-11-17** ([decisions](../decisions/owner-decisions-of-2026-11-17.md#the-evening-the-owner-present)):
in `1.7.0` a push for an UNNAMED group (#3793) shows the sender alone - the plain-notification rule for
a group with no name to show - and that stays. Naming the group by its members' first names in that
notification, as the app already does in the foreground, is this entry.

**What it needs, native on both platforms:** the Android notification builder (`CanariFCM`) and the iOS
notification extension compose a dead app's push from the server's push and the mirrored rows, where
an unnamed group's name is empty. They need the label every device draws
(`composeUnnamedGroupLabel`, [chat](../frontend/modules/chat.md#an-unnamed-group-no-name-stored-the-members-first-names-drawn)):
the group's tree members and their first names, mirrored where the native side can read them without
the WebView, with the same collation (`'fr'`), the same three-names-then-a-count rule, the viewer
left out, and a nickname set in the group winning. Nothing about the label may reach Google or Apple
([content-free push](push-payloads-carry-nothing-for-google-and-apple.md)): it is composed on the
device.

**Accepted meanwhile:** an older build shows "Groupe" for an unnamed group until step 3 of
[sealed names](p1-encrypt-the-names-of-groups-communities-and-salons.md) raises the minimum version.

**Closes with:** on the Mi 9T (app killed) and the iPhone 12 (app not running), a message in an unnamed
group of three titled with the two other members' first names; then one member removed, and the next
push following.
