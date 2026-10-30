# App Review for lives: the guideline 1.2 checklist, the video shot list and the notes (WP-L9, draft)

What a reviewer must be able to FIND and SEE for a build carrying lives (UGC streaming), mapped to
Apple guideline 1.2. **The requirements and what the app has are on [store-ugc-answers](store-ugc-answers.md)
(R1-R7), the only copy - this page adds the WHERE (which screen) and the HOW (the video).** The
guideline text is _(unverified against today's text)_: re-read
[Apple 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content) before sending.

**Nothing here has been recorded or run.** The phones were not touched writing it. Lives are compiled
into every build since the production flip of 2026-10-30 (`LIVE_ENABLED`, `frontend/src/lib/features.ts`),
so **a review build is any build from that commit on** - a stable before it shows the reviewer no live
at all - and the estate it talks to must have `lives_mode` `on`.

## 1. The reviewer's checklist

| 1.2 item | Where in the app | Screen to show | State |
| --- | --- | --- | --- |
| Report a live | viewer top bar, `Flag` button (`LiveReportControl`) opening `ReportReasonDialog`; then "block the person who is broadcasting" ([live](frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19)) | a running live: Flag, a reason, the confirmation | built, dev builds; device reading owed |
| Report one chat line | server accepts `live_chat`; the client control is #2170 ([store-ugc-answers R2](store-ugc-answers.md)) | the chat panel of a running live | **confirm it is merged and in the review build** |
| Report a post, a comment, a person | the item's own menu, same dialog ([moderation-and-blocking](moderation-and-blocking.md)) | one post, one profile | in production |
| Block | the person's profile; lifted in Settings, blocked section (`SettingsBlockedSection`); offered after a live report | profile, block, then the Settings list | in production |
| Hide a chat line, remove a viewer | the broadcaster's chat view (`LiveBroadcasterChat`); staff hide from the viewer ([live](frontend/modules/live.md#the-chat-and-the-floating-reactions-client-half-wp-l6-2026-10-19-draft)) | the broadcaster's phone while on air | built |
| Moderation of a running live, in time | `/admin/moderation`: a `live` report shows the live, its state and the broadcaster's standing; "Couper le live" with a confirmation; "Retirer le droit" once the server says it is due ([live](frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19)) | the admin queue before and after the cut; the viewer's end screen | built; **the 24 h commitment is decided, not measured** (the age alarm, #2189, is merged: confirm it runs) |
| Consequence for the broadcaster | warning, then 30-day suspension, then withdrawal; the broadcaster's bell row `live_cut` | the broadcaster's notification after the cut | server and staff half built; the broadcaster's own screens **owed** ([store-ugc-answers R6](store-ugc-answers.md)) |
| Terms accepted before posting | the first-live rules sheet at the broadcaster's start; `/legal/cgu` section 6 (objectionable content) | the sheet, then the terms page | sheet built; **the lives paragraph in the terms is the owner's text**; the sign-in consent stage is built and HELD ([authentik](infrastructure/authentik.md#the-terms-of-use-are-a-stage-of-the-authorization-flow-2026-10-16)) |
| Published contact | `/legal/cgu` section 15, `/legal/privacy`, the listing's support URL | the page, the listing | **placeholder open** ([store-ugc-answers R4](store-ugc-answers.md)) |
| Filtering | none automatic; post-hoc by report, auto-hide, cut | not shown; stated in the notes | **the owner's statement (R1)** |

## 2. The review video: shot list

One take per scene, fictional data only, the frame checklist of
[store-listings](store-listings.md#4-privacy-the-constraint-that-shapes-the-pipeline) applied to every
frame. Target 2-3 minutes, English captions added after capture, under 20 % of the area.

| # | Scene | On screen | Accounts |
| --- | --- | --- | --- |
| 1 | Sign-in the way the reviewer does ("Connexion externe (service-account)") | sign-in, home | review service account A |
| 2 | The terms | `/legal/cgu` sections 6 and 15, scroll | A |
| 3 | The broadcaster starts: the first-live rules sheet, Start | rules sheet, camera preview, "on air" | fictional broadcaster B, phone 1 |
| 4 | A viewer opens the live, sends a chat line and a reaction | viewer, chat panel | A, phone 2 |
| 5 | The broadcaster hides a chat line and removes a viewer | `LiveBroadcasterChat` | B |
| 6 | The viewer reports the live (reason), is offered the block, blocks; the Settings blocked list | Flag, dialog, confirm, list | A |
| 7 | The viewer reports one chat line | chat line report | A |
| 8 | Staff side: the report in `/admin/moderation`, the standing, "Couper le live", confirm | admin queue, desktop browser cropped to the page | moderator M |
| 9 | The cut reaches both: the viewer's end screen, the broadcaster's bell row | both phones | A, B |
| 10 | Report and block a post or person (non-live UGC: a reviewer judges the app) | profile menu | A |

**Accounts needed** (the owner creates them: a sign-in is production-adjacent, see
[store-listings](store-listings.md#4-privacy-the-constraint-that-shapes-the-pipeline)): the store-review
service account A, a fictional broadcaster B, a moderator M holding the moderation right, all on the
estate the review build points at, with A and B sharing a space so A sees B's live
([lives](services/lives.md#who-may-watch-the-rule-of-a-post)).

**To blur or avoid**: any real name in the directory, member lists and search (not scoped); the
"Environnement de test" banner on dev; the status bar and any notification; the admin queue's other
reports and any real reporter; the camera's picture (a neutral scene, never a face). A person views
every frame before it leaves the scratchpad.

**How to record, with the tooling that exists** (nothing run):

* **Mi 9T**: `adb shell screenrecord` (3 minutes per file, no sound), system UI demo mode as in
  [store-listings](store-listings.md#6-capture). `tools/phone-bench/phones.py` only decodes the stream
  for frame analysis; it writes no mp4. The bench phones are a sandbox; the Pixel 6a is the user's and
  is never used.
* **iPhone 12**: `tools/ios-device/ios.mjs` has `shot`, `tap` and `tree` and NO recording command; the
  recording is the iPhone's own screen recorder or QuickTime over USB from a Mac, with `ios.mjs`
  driving the taps. A live needs TWO devices at once, so scenes 3-4 are two takes joined, each real.
* **Admin scene (8)**: a desktop browser capture cropped to the moderation page.
* **The Play foreground-service demo video** (`canari-play-fgs-demo.mp4`) is not documented anywhere in
  this repository, so no recipe is reused from it: its method is a gap to close here once known.

## 3. App Review notes (English, draft)

The facts behind it: [store-ugc-answers](store-ugc-answers.md#what-to-write-in-the-review-notes-draft-english).
Brackets are the owner's values.

> Canari is the private network of the students and staff of one engineering school. Accounts exist
> only through the school's single sign-on and every member is an adult. This build adds live video
> broadcasts between members. Moderation of user-generated content, including lives:
>
> - Report: every post, comment, person and live broadcast, and each live-chat message, has a Report
>   control. Reports reach an in-app moderation queue read by the moderation team and are answered
>   within 24 hours on working days.
> - Block: any member can block another from their profile, or right after reporting a live; a block
>   hides each member from the other everywhere. Blocks are managed in Settings.
> - Remove: moderators remove posts and comments, restrict an account to read-only and end a live for
>   every viewer immediately. A broadcaster can remove a viewer and hide chat messages. A broadcaster
>   whose live is ended receives a warning; a repeat suspends broadcasting for 30 days; a further
>   repeat withdraws the right. Lives are not recorded and cannot be replayed.
> - Terms: members accept the live rules before their first broadcast; the terms of use define
>   objectionable content (section 6). Contact: terms of use, section 15 [support address].
>
> To review: sign in with "Connexion externe (service-account)" using [login / password]. This
> account can watch a live that a member of our team broadcasts during [window, Europe/Paris];
> contact [address] to arrange another time. The Flag button is in the top bar of the live. The
> moderation queue is shown in the attached video: [link].

## 4. What the owner must provide

1. The reviewer sign-in (service account A) and its secret, kept out of the repository; the broadcaster B and the moderator M.
2. A staffed window, or a standing arrangement, in which a team member goes live for the reviewer.
3. The filtering statement (R1), the terms' lives paragraph and the support address (R4, R5): [store-ugc-answers](store-ugc-answers.md#owed-before-a-submission-carrying-lives).
4. The build the reviewer gets: an external TestFlight pre-release (Beta App Review, the exposure of the 2.5.4 refusal, [mobile](frontend/mobile.md)) or a stable with lives flipped on.
5. A private link for the video, and a look at every frame.
6. Confirmation that the broadcaster's strike screens and the live-chat report control are in the review build.

## See also

- [store-ugc-answers](store-ugc-answers.md) - requirements R1-R7 and the gaps
- [live](frontend/modules/live.md) - the client as built; [lives](services/lives.md) - the server
- [store-listings](store-listings.md) - capture and the privacy checklist for frames
- [device-verification](device-verification.md) - what is owed on the phones
