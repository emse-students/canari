## P1 - A community's past goes only to a proven admission: merged (#2273, #2264), owed its readings and the floor (2026-10-22)

Decided by the user: communities stay `shared` by default, the past goes only to an admission a
member can verify, and a new user's arrival rotates (D5, #2263). Migration `107` is approved by the
user. Merged (#2273); #2264 is rebuilt on it, one chokepoint calling the gate. Owed, in order: the
rig rows COMM-26..31; and `minClientVersion` past it by
[the floor rule](../legacy-compatibility.md#the-floor-rule-raised-when-both-stores-serve-the-latest-update-owner-2026-10-24), since an older answering client still hands
the past to whoever the roster names. **The cut date is DECIDED** (user, 2026-10-23):
`ADMISSION_PROOF_SINCE` is the day the production stable carrying the proof ships, planned for
2026-10-27 UTC. **Old invite links are ACCEPTED as they are** (user, 2026-10-23): a newcomer through
an old link reads from arrival until a member re-admits them.

**Release checklist for that stable: before cutting its final pre-release, check that
`ADMISSION_PROOF_SINCE` (`frontend/src/lib/utils/graine/admissionGate.ts`) equals that stable's
day.** Design:
[channel-encryption section 25](../protocols/channel-encryption.md#25-a-member-hands-the-past-only-to-an-admission-it-can-verify-decided-by-the-user-2026-10-22).
