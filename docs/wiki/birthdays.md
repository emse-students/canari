# Birthdays on profiles

Decided by the owner on 2026-11-08 (part of [engagement](engagement.md)), built 2026-11-09. The
queue entry and the readings still owed are in
[backlog.d/birthdays-on-profiles.md](backlog.d/birthdays-on-profiles.md); the GDPR row is C26 of the
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

- `profile_birthdays`: `userId` (PK), `month`, `day`, `visibility`, `updatedAt`. CHECKs refuse a
  month outside 1..12 and a day the month cannot have (29 February is allowed, 30 February is not).
- `birthday_notices`: `(userId, celebratedOn)` PK - the durable fact that this birthday was
  announced on this Paris date.

Social-service holds the follows, the bell (`account_bells`) and the notifications, so the visibility
rule and the notice are one SQL statement each, with no cross-service call. **Core's profile DTO is
unchanged**: nothing about a birthday enters the profile cached on the device, so an offline profile
never shows a date its reader may no longer see.

The migration is purely additive (two new tables and an index, `IF NOT EXISTS`, `lock_timeout`), so
it is not held: `infrastructure/lib/migration-hold.sh` judges it plain. Every existing account starts
with no row - the field is optional and empty.

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
**The client never decides "today"**: the date comes from the database.

## The day, and 29 February

The day is the Paris calendar date read from the DATABASE, `(now() AT TIME ZONE 'Europe/Paris')::date`
(engagement L6). A birthday on 29 February is celebrated on **28 February in a common year**, on the
29th in a leap year: `celebratedOnSql` builds the date with `make_date(year, 3, 1) - 1` (the last day
of February) when the stored date does not exist that year. Proven for 2027, 2028 and 2100 (not a
leap year) in `birthdays.integration.spec.ts`.

## The morning notice

`BirthdayNotifier` (`birthday-notifier.scheduler.ts`) runs at minute 13 of every hour and does
nothing before 08:00 Paris (`BIRTHDAY_NOTICE_FROM_HOUR`), so a restart catches up the same day. For
each member celebrated today, in ONE transaction:

1. claim the day: `INSERT INTO birthday_notices ... ON CONFLICT DO NOTHING RETURNING` - **idempotence
   is this row, never a clock**: a second tick, a second replica or a restart finds the claim and
   tells nobody twice;
2. read the recipients: accepted followers who may see the date (so `nobody` tells nobody);
3. write their bell rows (`post_notifications`, type `birthday`, `postId` = the celebrant's id).

After the commit, `PostNotificationsService.pushNotice` fans out the pushes (content key
`social_birthday`, category `birthdays`). Each celebrant is its own `try`: one failure is logged and
the batch goes on. A school-visibility member's non-follower sees the date but is not told - the
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
  day and month selects, the three visibility choices with their consequence, save and remove.
- **The prompt card** `prompt-birthday` (`guides/birthdayPrompt.ts`, built on the profile-photo
  prompt's engine): ONE card on the feed for an account with no birthday, seen once per ACCOUNT
  (`help_seen`). **Why a card**: the field is empty for every existing account, and the ring and the
  notice exist only for a member who entered a date - a settings row nobody opens would leave the
  feature invisible. **Why no reminder**, unlike the photo: a birthday is personal data the member may
  simply not want to give, and asking twice is pressure; the profile section stays the way back.

## Erasure

`account-erasure.ts` deletes `profile_birthdays` and `birthday_notices` rows of the erased account;
the coverage spec asserts both columns. The bell rows naming the member go with the existing
`post_notifications` statements.

## Proofs

- `apps/social-service/src/birthdays/birthdays.integration.spec.ts` (PostgreSQL): the empty start,
  refused dates, the default visibility, the visibility matrix, the ring on the day only, 29
  February, the morning gate and idempotence, a hidden date telling nobody, the bell withholding,
  the bell row following the visibility, erasure.
- `birthday-date.spec.ts`: the two parsers' typed refusals.
- Frontend: `birthdayDate.test.ts`, `Avatar.birthday.svelte.test.ts` (the ring on initials and photo,
  nobody else's, gone at sign-out, never invented offline), `birthdayPrompt.test.ts`,
  `NotificationRow.svelte.test.ts`, `notificationTarget.test.ts`, and the native and category
  contract tests.
