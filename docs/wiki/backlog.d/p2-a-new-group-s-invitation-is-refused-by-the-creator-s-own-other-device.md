## Reading owed - a new group invites everyone chosen while the creator's other device is online (2026-11-17)

target: 1.7.0

**What failed, read on the iPhone 12, `1.7.0-alpha.10`, dev** ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)):
a group created from "Nouvelle discussion" (#3793) held its creator alone. The creation's commit
admitted the creator's other devices; the web seat swept the new group after its Welcome and held the
group's add lock to vouch for its siblings, and the iPhone's invitation was refused it in that second
(`add-lock-busy`), with no notice naming who was missing.

**What is built (#3799)** ([chat](../frontend/modules/chat.md#nothing-takes-the-add-lock-it-does-not-commit-under-2026-11-17)):
the pending sweep and the `welcome_request` answer take the add lock only once an Add is decided, and
claim the package under it; a member's first invitation that still meets another device's lock is
OWED (`add-lock-owed`), re-planned when that lock ends, never refused; an invitation that adds nobody
names everyone it invited (owner, 2026-11-17,
[decisions](owner-decisions-of-2026-11-17.md#the-evening-the-owner-present)).

**Closes with:** the creation on the iPhone 12 with the creator's web seat online, three times, each
inviting everyone chosen (the server log shows no `[ADD_LOCK] ... acquired=true` from the web seat
for the new group); and the same on the Mi 9T.
