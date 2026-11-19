## The owner's decisions of 2026-11-18

target: 1.7.1

Recorded so no question answered here is asked again. Taken by the owner in person, about 01:20 on
2026-11-18. Each line names where its detail lives.

1. **Lives G9, the iPhone BROADCASTER rotating: CLOSED BY THE OWNER'S DECISION, NOT READ.** *"Considère
   cette lecture faite et validée."* It was the one step left of the lives phone-reading entry after
   three `1.7.0` sittings (WebDriverAgent cannot rotate the device and no hand was at the bench); that
   entry is deleted, and no reading of the step exists
   ([readings](../device-verification.md#the-phone-readings-of-2026-11-18-170-alpha11-a-new-groups-invitation-with-the-creators-web-seat-online-and-reactions-in-the-background),
   [live-production G9](../frontend/modules/live-production.md#2-the-gates-each-with-its-evidence)). The
   moderation screens and the three broadcaster pushes, owed in their own entry, were read on both phones by
   sitting S6 and that entry is deleted ([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).
2. **A reading that needs a human hand on the phone** (rotating it, lighting a scene, a physical button)
   **and is not a regression is deferred by the lead alone to the next version's alpha**, written in
   [device-verification](../device-verification.md) and the [plan](../plan.md) (its entry's `target:`
   line moves). **A regression stays blocking.**
3. **After `1.7.1` the lead continues the plan** - the [slow-link chantier](slow-link-local-first-chantier.md),
   then the oldest entries - under the same release rules: pre-releases and stables after readings on
   both phones and nothing blocking, the owner told each time, no feature he did not ask for.
4. **Production data repairs: the lead runs them alone under four conditions** - the rows backed up
   first, an allowlist of the ids it may touch, a passing rehearsal on dev, an adversarial review - in
   ONE transaction. Never an account deletion, never a host security setting.

The release-authority bullet of `CLAUDE.md` carries 1, 2 and 4 in one sentence pointing here.

### The morning

Taken by the owner in person, about 09:10 and later that morning, relayed to the sitting S7
([readings](../device-verification.md#the-web-and-phone-readings-of-2026-11-18-s7-170-alpha12-the-last-sitting-before-the-stable)).

5. **Test accounts: the lead creates and manages as many MiConnect LOCAL test accounts as it needs**,
   on the condition that none is ever signed in on production (*"Le tout est de ne pas les connecter
   sur prod"*). Their credentials live with the other test accounts outside the repository; no
   account name enters the repository. First use: the throwaway account of the seed mirror's step 5,
   created, read, deleted from Settings and removed from the identity provider in S7.
6. **Birthdays' "gone the next day" and campus trends (from 2026-11-23) are read AFTER the `1.7.0`
   stable**: both move to `1.7.1`
   ([birthdays](reading-owed-birthdays-on-profiles-3180-first-stable-v1-6-9-birthdays.md),
   [campus trends](reading-owed-campus-trends-and-the-daily-cap-wp-8-wp-10-and-the-quieter-batch.md)).
7. **The `1.7.0` stable is cut as soon as this last sitting is green.**
8. **After `1.7.0`: the `1.7.1` defects first, then group calls.** `1.7.1` keeps its WHOLE list, even if
   it takes several weeks.
9. **An App Store review refusal is ALWAYS the owner's**: the lead prepares the answer and the fix, the
   owner sends them.
10. **Dependabot:** a minor bump merges on a green CI; a major bump needs an adversarial review, a green
    CI and a pass on dev before a stable, and a major touching authentication is read on both phones.
11. **Stable cadence:** a stable ships as soon as a version is ready (its readings pass on both phones),
    and an urgent fix may ship alone.

### The afternoon, after the stable

Taken by the owner in person, once `1.7.0` was out.

12. **CanaReel viewer, the overlay (`1.7.1`).** A single tap hides or shows the overlay - caption,
    author, action column, top tabs, close button. The thin playback bar stays. The overlay comes back
    only on the next tap or on the next reel. **Pausing is a long press only.** The playback bar is
    sized to the TRUE duration from the first frame, with YouTube-style grey buffered ranges under it.
13. **Admin queues (`1.7.1`).** A live count badge on the Administration entry and on each queue's
    navigation item; a bell notification AND a push to every GLOBAL admin when an item arrives,
    cleared for all as soon as one admin handles it. Every admin queue runs through ONE mechanism,
    not one per queue.
14. **The `1.7.0` floor is raised by the owner** (`minClientVersion`) as soon as BOTH stores serve
    `1.7.0`, so the legacy shims can then be removed
    ([legacy-compatibility](../legacy-compatibility.md)).
