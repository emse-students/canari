## P3 - A removal that closes no interval is invisible to `departed_and_undated` (review of #2791, 2026-10-31)

Not built. The gate refuses an undated Add of an awaiting seat whose person ever departed
(`enrolAdmittedPeople`, `departed_and_undated`), reading closed stretches and Declines. One removal
path closes none: `removeGroupMember` of a member enrolled with no open interval (a writer still on
pre-030 code during that deploy; it logs `[REMOVE_MEMBER] ... had NO open membership interval`).
Such a person who rejoins by link and still has a stale leaf can be admitted by an undated
automatic Add from an older client; the push door is closed anyway (`mayAnswerAsk: false`), and the
current foreground refuses the seat (`admissionOfSeat`). Account erasure and an ask's expiry are not
this case: an erased account cannot come back, and an expired ask was never a member. Fix if the
`NO open membership interval` line has ever fired in production: record the removal's generation
on `dm_seat_evictions` as a Decline does.
