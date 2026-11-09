## P2 - birthdays on profiles (owner, 2026-11-08, engagement) - built, readings owed

The owner wants members to enter their birthday, the day visible on the profile, and on the day a festive ring around the profile photo everywhere in the app (also for others, so they can wish it) - part of the adoption/engagement strategy ([engagement](../engagement.md)).

Decisions (owner, 2026-11-08): (1) day and month ONLY - the year is never asked, no age shown or computed; (2) visibility of the date outside the day is the member's choice - everyone at the school / their followers / nobody - default FOLLOWERS, same mechanism as the other profile fields ([profiles-and-access](../profiles-and-access.md)); (3) on the day the ring around the avatar is shown to EVERYONE, whatever (2) says (the owner accepted that the date becomes guessable on that day); (4) on the morning of the day a notification "C'est l'anniversaire de X" goes to the member's followers who may see the date, switchable off in the notification settings.

Built 2026-11-09, everything owed at decision time included - the mechanism, each choice taken while building and why, and the proofs are on [birthdays](../birthdays.md): social-service migration 148 (additive, not held), the shared profile-field visibility rule, the ring on the one `Avatar.svelte`, Feb 29 on Feb 28 in a common year (integration-tested), the hourly notifier from 08:00 Paris claiming each notice through `lastAnnouncedOn`, the rules against moving the date (engagement L23), the `birthdays` notification category, the bell (engagement L22), erasure, the GDPR register row C26 and the privacy policy, Profile > Anniversaire, and ONE prompt card with no reminder.

**Readings owed** (on dev, after a pre-release; a test account whose birthday is set to the day of the reading):

1. The ring on both phones (Mi 9T, iPhone 12): feed, chat list, a conversation, the profile - on the photo and on initials - and gone the next day.
2. The profile line "C'est son anniversaire aujourd'hui" seen by a non-follower whose visibility hides the date, with no date shown to them.
3. The morning notice: one bell row and one push per follower who may see the date, on Android AND iOS (the native `social_birthday` texts in clear, the tap opening the profile), and never a second one after a restart of social-service.
4. The category `Anniversaires` switched off: no push, the bell row still there.
5. The settings after a first save: the note that the date counts from tomorrow, then the date locked with the day it opens, and no ring on the day it was set (the review's rules, [birthdays](../birthdays.md#a-date-cannot-be-moved-to-buy-a-ring-or-a-notice-lead-decision-2026-11-09)).
6. The prompt card on both phones for an account with no date: shown once, "Ajouter mon anniversaire" opens the section, never shown again on the other phone.
7. One week after the stable: `SELECT visibility, count(*) FROM profile_birthdays GROUP BY 1` on production, to measure adoption and the default's share.

29 February on the 28th is proven by the integration test only (no reading can wait for 2027-02-28).
