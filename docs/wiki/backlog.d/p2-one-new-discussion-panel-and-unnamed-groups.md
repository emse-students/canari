## P2 - one "Nouvelle discussion" panel, and groups unnamed by default (owner, 2026-11-17)

target: 1.7.1

The owner, 2026-11-17: creating a group took four steps (the panel, the "Groupe" tab, a name, then
adding people to an empty group). Built: one panel where people are chosen first - one opens the
1:1, several open a name step whose empty field suggests the members' first names, and keeping the
suggestion creates an UNNAMED group that stores no name anywhere and is drawn on every device by its
current members' first names. The mechanism and the decisions are in
[chat](../frontend/modules/chat.md#one-new-discussion-panel).

What closes it, on the `1.7.1` pre-release:
- a reading on the Mi 9T and the iPhone 12: create a group of three unnamed, check the list, the
  header, the search and an in-app notification name the two others by first name on BOTH phones,
  then remove one member and check the label follows on both;
- the owner's answer on whether a push raised while the app is dead should title an unnamed group
  by its members' first names (native code: the Android builder and the iOS extension read the
  mirrored rows, where an unnamed group's name is empty - today such a push reads as the sender
  alone, the plain rule for a group with no name to show).
