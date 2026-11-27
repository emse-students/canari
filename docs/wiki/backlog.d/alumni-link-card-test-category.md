## P3 - the Alumni link card is shown to test accounts: no profile value says "test"

target: 1.8.4

The owner (2026-11-27) wants the bench and test accounts spared the Alumni reminder, by a "test" category. Nothing in the profile means "test" today: the formations are `ICM`, `ISMIN`, `FISA`, `PDIS`, `Autre`, the posts `EMSE`, `ME`, `ALUMNI`, the campuses two, read by `parseProfileClaims` (core-service `users/miconnect-profile.ts`) and mirrored in `frontend/src/lib/profile/miconnectProfile.ts`. The decision belongs where the card decides, `alumniLinkReminderDue` (`lib/profile/alumniLink.ts`), once a value exists. Choices for the owner: a new MiConnect enrolment attribute or formation value (a change to the ONE shared production MiConnect instance, never made from here), or an allowlist of ids in core-service environment served as a flag on the reader's own profile. A pinned test accompanies whichever: a profile in the category is never due. Delete this file when it ships.
