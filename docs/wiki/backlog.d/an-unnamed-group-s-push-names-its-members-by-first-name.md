## Read on both phones: a push raised while the app is dead titles an unnamed group by its members' first names (owner, 2026-11-17)

target: 1.8.3

_2026-11-27: BUILT (the native title, composed on the phone by one Rust rule held to the app's by
`libs/contracts/unnamed-group-label.cases.json`); what is left is the reading below. The Rust and the
web halves are tested and the Android Kotlin compiles locally; the iOS extension's Swift and the
app process's Objective-C (`canari_push.mm`, the same Rust call) were NOT compiled (no Mac here), so
their first build is part of this reading._

_2026-11-26: moved to 1.8.3 when 1.8.2 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**The owner, the evening of 2026-11-17** ([decisions](../decisions/owner-decisions-of-2026-11-17.md#the-evening-the-owner-present)):
a push for an UNNAMED group is to be titled by its members' first names, as the app already does in the
foreground. How it is built: [chat](../frontend/modules/chat.md#an-unnamed-group-no-name-stored-the-members-first-names-drawn).

**Accepted meanwhile:** a build older than this one shows "Conversation de groupe" on a dead app's push;
an older build still shows "Groupe" for an unnamed group until step 3 of
[sealed names](p1-encrypt-the-names-of-groups-communities-and-salons.md) raises the minimum version.

**Closes with:** on the Mi 9T (app killed) and the iPhone 12 (app not running), with the app opened
once first on that build (so the name copy holds the members' first names), a message in an unnamed
group of three titled with the two other members' first names ("Alice et Bob"); then one member
removed from another device while the phone's app stays dead, and the next push titled with the one
left. `[GROUP_LABEL]` in the logcat / the extension's log says which way each banner went.
