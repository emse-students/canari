# Store review: the user-generated-content answers (WP-L9, Q2)

What Apple's App Review guideline 1.2 and Google Play's User Generated Content policy ask of an app
whose members publish to each other, mapped to what Canari HAS today (read in this repository on
2026-10-19) and what is MISSING. Written for live (WP-L9 of [live](frontend/modules/live.md); decision
D3: the answers precede any store submission carrying lives), but it covers every UGC surface,
because a reviewer judges the app, not the feature.

**Convention: the store requirements below are restated from memory of the published texts and are
_(unverified against today's text)_.** Re-read [Apple 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content)
and [Google Play UGC](https://support.google.com/googleplay/android-developer/answer/9876937)
before the submission, and correct this page where they differ.

## What each store asks

| # | Requirement | Apple 1.2 | Google Play UGC |
| --- | --- | --- | --- |
| R1 | A way to FILTER objectionable material from being posted | yes | "robust, effective and ongoing moderation" |
| R2 | A way to REPORT offensive content, with a timely response | yes | yes, in-app, content AND users |
| R3 | A way to BLOCK abusive users | yes | yes, in-app |
| R4 | Published CONTACT information | yes | (developer contact on the listing) |
| R5 | Terms of use the member ACCEPTS before posting, defining objectionable content | (implied by R1/R2) | yes, explicit |
| R6 | Act on reported content and accounts (remove, restrict) | yes ("timely") | yes |
| R7 | Live streaming specifically: moderation of a live while it runs | (covered by 1.2; Apple reviewers have asked for a demonstration video, L7) | the UGC policy applies to live content |

## Mapped to Canari today

| # | What Canari has | Where | What is MISSING |
| --- | --- | --- | --- |
| R1 | **No automatic content filter** (no keyword or image classifier). Posts: auto-hidden at 5 distinct reports, and a moderator can hide one; a member can be muted (read-only). Lives: a staff CUT ends a live for everyone at once (server built, WP-L8). Chats are end-to-end encrypted: the server cannot filter them, by design | [moderation-and-blocking](moderation-and-blocking.md), [lives](services/lives.md#moderation-wp-l8-server-half) | **A decision**: state in the review notes that filtering is post-hoc (report, auto-hide, staff action) on an invitation-only school network of adults, and that E2E content is filtered by report only - or add a filter. Owed to the user |
| R2 | In-app report of a **post, a comment, a person** (one reason list, once per person per thing), read by moderators in `/admin/moderation`. **A live**: the server accepts `contentType: 'live'` (WP-L8); the viewer's report control is NOT built | `content_reports`, `ReportReasonDialog`, `/admin/moderation` | the live report control (client half of WP-L8); **a written response-time commitment** (none exists: the terms say "un délai raisonnable" for appeals only) - owed to the user, e.g. "reports reviewed within 24 h on school days" |
| R3 | In-app **block** of a person from their profile: hides posts, comments and lives both ways, refuses 1:1 chats, group adds, salon invitations and calls; lifted only from Settings | [moderation-and-blocking](moderation-and-blocking.md#blocking) | nothing for posts and people; a block control reachable FROM a live viewer (it is on the profile today) is part of the live client half |
| R4 | The terms of use (`/legal/cgu`, section 15 "Contact et mentions légales") and the privacy policy (`/legal/privacy`) publish the association's contact e-mail; a child-safety page exists (`/legal/child-safety`) | `frontend/src/routes/legal/` | **[CONTACT PLACEHOLDER: the support address and URL the store listings name]** - confirm the listings' support URL points at the terms or privacy page, not at the old `canari-emse.fr` name ([store-listings](store-listings.md)) |
| R5 | The terms of use define the objectionable content and the moderation process (section 6). **The consent stage at sign-in is BUILT AND HELD** (not applied: [authentik](infrastructure/authentik.md#the-terms-of-use-are-a-stage-of-the-authorization-flow-2026-10-16)). **Lives**: a member accepts the first-live rules before broadcasting, recorded per account and version, the start refused without it (server built, WP-L8; the broadcaster's rules sheet sends the field) | `/legal/cgu`, `live_rules_acceptances` | the terms stage lifted from its hold (its three conditions are in [backlog](backlog.md)); the terms' section 6 gaining a paragraph on lives (the cut, the first-live rules, no replay) - the TEXT is the user's |
| R6 | Moderators (`isContentModerator`: platform admins, BDE members holding `MODERATE`) delete or hide posts and comments, unmask an anonymous author, mute an account; **cut a live** (server built). A cut is recorded with who, when and why | `/api/moderation/*`, `/api/posts/*`, `POST /api/lives/:id/cut` | the admin cut button (client half); **a strike policy** - what repeated cuts trigger - is the user's decision (no automatic sanction exists for posts either) |
| R7 | Lives: the broadcaster removes a viewer (built), hides a chat line (WP-L6, contract written in [lives](services/lives.md#hiding-a-chat-message-the-contract-for-wp-l6)), any viewer reports, staff cut; lives are not kept (no replay, L3); all users are adults (L11) | [lives](services/lives.md#moderation-wp-l8-server-half) | the client halves above, the chat hiding, and **the review video** showing a report and a cut on a running live (L7, WP-L9) |

## What to write in the review notes (draft, English)

> Canari is the private network of the students and staff of one engineering school; every account
> is created through the school's single sign-on, and every member is an adult. Members can report
> any post, comment, person or live broadcast from the item itself; reports reach the moderation team
> (school-association officers holding the moderation right, and platform administrators) in an
> in-app queue. Moderators can remove posts and comments, restrict an account to read-only, and end
> a live broadcast for every viewer immediately. Any member can block another member, which hides
> each from the other everywhere. Before a first live broadcast, a member must accept the live rules.
> Private conversations are end-to-end encrypted and are moderated by report. Contact: see the terms
> of use, section 15. [RESPONSE-TIME COMMITMENT: owed to the user]

## Owed before a submission carrying lives

1. The client half of WP-L8 (report control, cut screens, admin cut button; the rules step is built) - code.
2. The response-time commitment, the filtering statement (R1) and the strike policy - **the user's**.
3. The terms' lives paragraph - **the user's text**; the privacy policy line with register rows C19
   and C20 ([register-of-processing](compliance/register-of-processing.md)).
4. The review video (L7) and this page re-read against the stores' current texts.

## See also

- [moderation-and-blocking](moderation-and-blocking.md) - reports, auto-hide, blocks
- [lives](services/lives.md#moderation-wp-l8-server-half) - the live's moderation as built
- [mobile](frontend/mobile.md) - the submission notes
- [store-listings](store-listings.md) - the listings' texts and support URL
