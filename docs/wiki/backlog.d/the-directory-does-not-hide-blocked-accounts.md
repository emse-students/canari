# P3 - the people directory does not hide blocked accounts, and every member can now open it

`UsersService.directory` applies the review-cohort rule but, deliberately, not `applyBlockVisibility`
(its comment: a block must not show in a browsing screen). The New chat, salon invitation and mention
search DO hide blocked accounts, symmetrically. Opening the directory to every signed-in member
(2026-11-13) means a person who blocked someone can be found by that person in the directory, by name,
though not in a target picker. Owner's stance: Canari lets everyone see everyone, so no restriction was
built. Decision owed: keep (the block closes contact, not visibility) or reuse `applyBlockVisibility`
in `directory` (one implementation, one test in `users.service.spec.ts`).
