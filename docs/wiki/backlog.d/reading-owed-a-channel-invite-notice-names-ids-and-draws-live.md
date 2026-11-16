## Reading owed - a salon invitation's notice, in the invitee's and the members' language (2026-11-16)

target: 1.7.0

**What is built:** inviting someone into a salon sends `memberAdded` with `{ "newUsers": [id] }`, not a
rendered sentence. Every reader (live frame and history page) draws the row with the one notice
rendering, names resolved at read time ([chat](../frontend/modules/chat.md#a-salons-membership-notice-carries-ids-2026-11-16)).
A legacy sentence frame is still read as that sentence. Proven by unit tests only.

**The reading that closes it:** on dev, an admin invites account B into a salon; account C (set to
the other language) reads "X a ajoute B" / "X added B" with live names, centred, on the live frame AND
after a reload (history); the row neither counts as unread nor rings. Also open a salon whose history
holds an OLD sentence notice: it still reads as the sentence. Any raw `{"newUsers"...}` text on screen
is a FAIL.
