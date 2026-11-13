# Birthdays on profiles

Decided by the owner on 2026-11-08 (part of [engagement](engagement.md)), built 2026-11-09. Shipped in
`1.6.9` (#3180). Read on `1.6.9-alpha.1` (2026-11-09, dev): the prompt card PASSED on both phones
(shown once, "Ajouter mon anniversaire" opening the section, gone after "Passer" and a cold
restart); the settings PARTIAL (the "counts from tomorrow" note and no ring on the day of the save
seen, the locked state not, since a same-day correction is accepted by design). The readings still
owed are an entry of [the readings owed](plan.md#readings-owed); the GDPR row is C26 of the
[register](compliance/register-of-processing.md), whose public face is `/legal/privacy`.

## The four decisions

1. **Day and month ONLY.** The year is never asked, stored or shown, and no age is computed anywhere.
2. **Who sees the date outside the day is the member's choice**: `school` (everyone at the school),
   `followers` (the DEFAULT) or `nobody`.
3. **On the day, the festive ring around the avatar is shown to everyone**, whatever (2) says - the
   owner accepted that the date becomes guessable on that day. It is drawn by the ONE shared avatar
   component (`frontend/src/lib/components/shared/Avatar.svelte`), never per call site; the profile
   page says it is their birthday.
4. **On the morning of the day**, "C'est l'anniversaire de X" goes to the member's followers who may
   see the date. The reader can switch it off (notification category `birthdays`).

## Where the data lives, and why there

Everything is in social-service, migration `148_profile_birthdays.sql`:

- `profile_birthdays`: `userId` (PK), `month`, `day`, `visibility`, `dateSetAt` (when the DATE was
  last set - a visibility edit leaves it), `lastAnnouncedOn` (the Paris date the followers were last
  told, the notice's claim), `updatedAt`. CHECKs refuse a month outside 1..12 and a day the month
  cannot have (29 February is allowed, 30 February is not). "Retirer" deletes the row, and with it
  the date and its visibility.
- `birthday_changes`: `userId` (PK) and two facts that outlive a removal on purpose, never a date of
  birth: `changedAt` (when a date was last set - the 30-day window) and `noticeOpensOn` (written by
  a removal that follows an announcement: `lastAnnouncedOn + 300`, the first day a notice or a ring
  is possible again). The notifier's hourly job empties each once it passes and deletes the empty
  row.

Social-service holds the follows, the bell (`account_bells`) and the notifications, so the visibility
rule and the notice are one SQL statement each, with no cross-service call. **Core's profile DTO is
unchanged**: nothing about a birthday enters the profile cached on the device, so an offline profile
never shows a date its reader may no longer see.

The migration is purely additive (two new tables and an index, `IF NOT EXISTS`, `lock_timeout`), so
it is not held: `infrastructure/lib/migration-hold.sh` judges it plain. Every existing account starts
with no row - the field is optional and empty.

## A date cannot be moved to buy a ring or a notice (lead decision, 2026-11-09)

The adversarial review of #3180 found that moving the date every day would give a school-wide ring
and a push to every follower EVERY day; its re-review found that a removal then a new date reopened
the notice monthly. These rules close both (engagement L23, amended the same day), each reversible by
one constant or one condition:

1. **A date counts from the NEXT Paris day.** The ring, the profile's "today" line and the notice all
   require `dateSetAt` before today began (`dateInEffectSql`), the first date included: a member who
   enters their birthday on the day itself is celebrated next year.
2. **One notice per member per 300 days** (`BIRTHDAY_NOTICE_EVERY_DAYS`), wherever the date is
   moved: the claim (`noticeOpenSql`) refuses while `lastAnnouncedOn` is closer than that, AND before
   a `noticeOpensOn` a removal kept. **A removal after an announcement keeps `noticeOpensOn =
   lastAnnouncedOn + 300` and nothing else** (option a of the re-review): a new date may then be set
   under rule 3, but is neither announced nor ringed before that day. Kept at most 300 days after the
   announcement, it roughly dates the last birthday; the register (C26) and the policy say so.
3. **The ring follows the notice** (`celebratedTodaySql`): on its day, a date is ringed only when
   that day's notice was sent (`lastAnnouncedOn` = today) or may still be (rule 2). Moving the date
   monthly therefore moves no ring either.
4. **A NEW date at most once per 30 days** (`BIRTHDAY_CHANGE_WINDOW_DAYS`, counted in Paris dates).
   The first date opens the window, and a removal then a new date counts as a change; a visibility
   edit, or setting the same date again, is never one. **A correction the same Paris day as the
   window's first set is accepted and keeps the window** (a typo, or a removal then a set that day):
   it buys nothing, since a date set today counts from tomorrow. The settings show the day the window
   opens (`changeOpensOn` from `GET posts/me/birthday`, `null` while a correction is still accepted)
   and lock the date and the Save button until then, so the form never learns it by a refusal; a
   second device racing the first meets `409 BIRTHDAY_CHANGE_TOO_SOON` (with `opensOn`), shown as its
   own message. Removing the date is always accepted. Every write of a member's birthday takes
   `pg_advisory_xact_lock(hashtextextended('profile_birthdays:' || id, 0))`.

## Who sees what

One shared rule decides a profile field's visibility: `profileFieldVisibleToSql` in
`apps/social-service/src/birthdays/profile-field-visibility.ts`. No per-field mechanism existed
before (the profile fields come from MiConnect and are school-wide); this is the one the next
optional field reuses.

| Viewer | Date (`GET posts/users/:id/birthday` -> `birthday`) | "Today" (ring, profile line) |
| --- | --- | --- |
| the member themself | always | on the day |
| blocked either way | never | never |
| across the review-cohort boundary (`sameSideOfReviewCohortSql`) | never | never |
| an ACCEPTED follower | `school`, `followers` | on the day |
| a pending request, or anyone else at the school | `school` only | on the day |

The "today" answer carries no date. The ring list is `GET posts/birthdays/today` -> the Paris date
and the ids of the members the viewer may see celebrating; the client holds it in memory only
(`birthdaysToday.svelte.ts`), refreshes it on focus and visibility change, and drops it at sign-out.
**The client never decides "today"**: the date comes from the database. Refreshed on focus and
visibility only: a tab left open in the foreground over midnight keeps yesterday's ring until it is
next focused or shown.

**Asked once per Paris day (2026-11-10).** The held answer carries the server's date; a focus or
visibility refresh asks nothing while that date is still the Paris date (a read per focus was nine in
five minutes on a slow link). A new day, another account, a failed ask or the reader saving or
removing their own birthday (`invalidate`, then an immediate ask) reads again. The client only
compares the held date with the Paris calendar day, as a key; "today" for the ring stays the server's.
A member who enters a birthday later the same day is drawn from the next day.

## The day, and 29 February

The day is the Paris calendar date read from the DATABASE, `(now() AT TIME ZONE 'Europe/Paris')::date`
(engagement L6). A birthday on 29 February is celebrated on **28 February in a common year**, on the
29th in a leap year: `celebratedOnSql` builds the date with `make_date(year, 3, 1) - 1` (the last day
of February) when the stored date does not exist that year. Proven for 2027, 2028 and 2100 (not a
leap year) in `birthdays.integration.spec.ts`.

## The morning notice

`BirthdayNotifier` (`birthday-notifier.scheduler.ts`) runs at minute 13 of every hour and does
nothing before 08:00 Paris (`BIRTHDAY_NOTICE_FROM_HOUR`), so a restart catches up the same day. For
each member celebrated today whose date is in effect, in ONE transaction:

1. claim the day: `UPDATE profile_birthdays SET "lastAnnouncedOn" = today WHERE ...` re-checking the
   day, the date in effect and the 300 days on the row it locks - **idempotence is this column, never
   a clock**: a second tick or replica waits on the row lock, re-reads it and fails the condition, so
   nobody is told twice;
2. read the recipients: accepted followers who may see the date (so `nobody` tells nobody);
3. write their bell rows (`post_notifications`, type `birthday`, `postId` = the celebrant's id).

After the commit, `PostNotificationsService.pushNotice` fans out the pushes (content key
`social_birthday`, category `birthdays`). Each celebrant is its own `try`: one failure is logged and
the batch goes on. A push that fails after the commit is logged at error and not retried (a retry
would be the duplicate the claim exists to prevent); **a crash between the commit and the push loses
that push with no trace**, while the bell rows survive. Each tick also empties the
`birthday_changes` facts that have passed and deletes the rows left empty. A school-visibility member's non-follower sees the date but is not told - the
notice is for followers (decision 4).

- **The bell** (engagement L22): a bell on the celebrant at `lives` or `none` withholds the push; the
  bell row is still written.
- **The bell row follows the visibility**: `birthdayRowShownSql` is part of `bellRowShownSql`, so a
  row is shown only while its reader may still read the date (an unfollow, a block or a change to
  `nobody` hides it). A push already delivered cannot be recalled.
- **Native texts**: the Android resources, the iOS app and NSE `Localizable.strings`, the Kotlin and
  Swift maps and `canari_push.mm` carry `social_birthday`; `nativeStrings.test.ts` and
  `push-content.spec.ts` hold them to the server's sentence.

## The entry point and the prompt card

- **Profile > Anniversaire** (`profileSections.ts`, section `birthday`; `ProfileBirthdaySection.svelte`):
  **minimal since 2026-11-10 (owner)**: one day + month row, one "Visible par" choice (a `Select`, no
  per-choice explanation), one effect sentence (a date counts from tomorrow and holds 30 days; while
  the window is open, the day it opens instead), save and remove - **plus ONE always-visible
  disclosure sentence**: on the day the festive ring is shown to everyone and followers are told
  according to the choice (decision 3), so the privacy statement does not depend on which option is
  open. The register (C26) and the policy already say both, so they did not change.
- **The prompt card** `prompt-birthday` (`components/posts/BirthdayFeedCard.svelte`): since 2026-11-10 a
  SMALL QUIET CARD at the top of the feed - "🎂 Votre anniversaire ?" (the app says "vous"), an "Ajouter" action, a cross - for
  an account with no birthday. It replaced the self-opening modal of 1.6.9 (too insistent; its button
  overflowed a phone). **Dismissed means gone**: the cross and "Ajouter" both record the help in the
  account's `help_seen` (`seenHelps`, the profile-photo prompt's store), so it never returns on any
  device - durable state, no timer. It shows only once `seenHelps.ready` and
  `ownBirthday.hasBirthday === false`. Since 2026-11-11 both are drawn from the device at a cold
  start and revalidated behind (`hasBirthday` is kept per account as ONE boolean about the account
  itself, never the date - `ACCOUNT_KEY.ownBirthdayKnown`), so the card no longer waits for the
  session refresh; today's celebrants stay in memory only. The help id `prompt-birthday` is kept (the server lists it) but
  no guide declares it any more. **Why a card**: the field is empty for every existing account, and the
  ring and the notice exist only for a member who entered a date. **Why no reminder**: a birthday is
  personal data the member may not want to give; the profile section stays the way back.
- **On a profile** (`ProfileSummaryLine.svelte`): ONE muted line under the name,
  "ICM · Saint-Etienne · 🎂 18 juillet" (formations, posts, campus, the birthday when the visibility
  rule lets the reader see it - no pill, no "Anniversaire le" sentence), plus the "birthday today"
  line on the day itself.

## Erasure

`account-erasure.ts` deletes the `profile_birthdays` and `birthday_changes` rows of the erased
account; the coverage spec asserts both columns. The bell rows naming the member go with the existing
`post_notifications` statements.

## Proofs

- `apps/social-service/src/birthdays/birthdays.integration.spec.ts` (PostgreSQL): the empty start,
  refused dates, the default visibility, the visibility matrix, the ring on the day only, 29
  February, the morning gate and idempotence, a hidden date telling nobody, the bell withholding,
  the bell row following the visibility, erasure; a date set today celebrated from its next
  occurrence only; one notice in 300 days wherever the date moves; after an announcement, a removal
  then a new date announced and ringed on none of its days before day 300; no ring on a day whose
  notice is closed (a monthly move); a new date refused within 30 days (a removal then a set
  included), same-day corrections accepted without restarting the window, and the purge.
- `birthday-date.spec.ts`: the two parsers' typed refusals.
- Frontend: `birthdayDate.test.ts`, `ProfileBirthdaySection.svelte.test.ts` (the note before the
  first save, the date locked while the window is open, a refusal from another device),
  `Avatar.birthday.svelte.test.ts` (the ring on initials and photo,
  nobody else's, gone at sign-out, never invented offline), `BirthdayFeedCard.svelte.test.ts`,
  `NotificationRow.svelte.test.ts`, `notificationTarget.test.ts`, and the native and category
  contract tests.
