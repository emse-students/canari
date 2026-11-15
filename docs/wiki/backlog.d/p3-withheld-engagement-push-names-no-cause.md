## P3 - the "withheld" line of a capped push names no cause, so a missing push is found by querying the database

target: 1.7.0

A reading on dev (2026-11-15) saw a booking-space opening push never reach a killed phone while two
form openings did. The social-service line was `[NOTIFY] type=booking_open withheld 1 of 1 (cap,
category bookings off, or no device at 1.6.9) - the bell rows stay`: three causes in one sentence, so
the answer had to be read out of `engagement_push_days` by hand (the reader's counter was already at
the cap of 3 for the Paris day - correct behaviour: `booking_open` is a COUNTED type and `form_reminder`
is free, see [engagement](../engagement.md)).

`withinPushBudget` (`apps/social-service/src/posts/post-notifications.service.ts`) knows only the set
`claimEngagementPushes` returned. Make the claim's own statement say WHY each withheld reader was
dropped (capped, category off, no device at the floor) and log the three counts apart, per the rule that
a correct mechanism with no report is found by hand a day late. No behaviour change: the cap, the
category and the floor stay as they are.
