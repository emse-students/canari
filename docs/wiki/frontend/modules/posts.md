# Posts module

**Routes**: `src/routes/posts/`, `src/routes/post/[postId]/`  
**Components**: `src/lib/components/posts/`

## Responsibilities

- News feed with three tabs: all posts, followed associations, by category.
- Post creation with rich content: Markdown, image, poll, embedded form.
- Reactions (emoji), comments, post sharing.
- Search within the feed.
- Pin/unpin (admin only).
- Report posts (moderation).

## Feed tabs

| Tab (`feed=`) | Content |
|---|---|
| Associations (`associations`, the default) | What associations publish AND republish - a member's post an association carries is ONE card there, "Republie par X", placed at its latest republication |
| Suivis (`followed`) | Posts from the associations and members the reader follows (never an anonymous post), and what a followed association republished, placed at that republication |
| Mon espace (`all`, "Tout" until 1.6; the identifier is unchanged) | Every post the reader may see through their spaces, campus and formation. The row also carries an (i) button (`FeedTabsInfo`) explaining the three tabs |

**A republication is an association publishing, so the feeds of what associations publish carry it
(user, 2026-10-24).** The Associations and Suivis arms of `listPosts` read `posts."associationId"`
alone, so a member's post the BDE republished (D38b) entered neither, only "Tout" under its own
date. The client filters nothing per tab, so the server's clauses were the whole cause. The clauses
now live in `apps/social-service/src/posts/republished-feed-sql.ts`:

- a row is in Associations when an association published it OR a republication of it COUNTS for
  the reader; in Suivis, when a followed association republished it (never an anonymous post). It
  is an `EXISTS`, never a join, so a post carried twice is still one row;
- it is placed at `GREATEST(publishedAt, latest counted republishedAt)` - pinned posts still first,
  the CanaReels list with no pin;
- a republication COUNTS only when it is by an association the reader sees
  (`associationVisibleToUserSql`, read grants included) - and, in Suivis, one they follow - so a
  republisher the reader cannot see neither admits a post nor moves it.

Visibility of the post itself is untouched (`postVisibleToUserSql` already lets a republisher's
audience read it), and since a member's post can now be in the Associations arm, `blockedAuthorSql`
applies there as in the others. Proven against PostgreSQL by
`republished-feed-sql.integration.spec.ts`. The card still shows the post's own `publishedAt`; only
its place is the repost's. What a republication still does not move is in
[backlog](../../backlog.md#p3---what-a-republication-still-does-not-move-in-the-feeds-review-of-2384-2026-10-24).

Posts are loaded via `GET /api/posts` (social-service), paginated with infinite scroll (`IntersectionObserver`).

The tabs and a clap icon share ONE row (`FeedTabRow`, 2026-10-16): the icon opens the full-screen
reel viewer at the newest reel, and the feed itself is never filtered to reels - the 2026-10-15
filter bar is gone ([reels](reels.md#the-canareels-entry---an-icon-beside-the-tabs-that-opens-the-viewer-user-2026-10-16)).
The publisher's picture, name and link (`PostAuthorAvatar`, `postAuthorName`, `postAuthorHref`)
and the text renderer (`PostMarkdown`) are shared by the card and the reel viewer's overlay.

### Who wrote it: "Anonyme" big, the real author small (2026-10-24)

The user's two decisions, for posts, reels and comments alike:

- **"Republie par X" sits on the time's line** - "2 h . [repost] Republie par BDE" - not on a line
  of its own (`PostHeader`'s `data-post-time-line`, `ReelSlide`'s `data-reel-time-line`; the words
  are `republishedByText`, one implementation). It names ONE republisher and counts the rest
  ("Republie par BDE +2"), and it gives way first: on the card it truncates before the time; in the
  reel overlay, where it shares the author's row, the time line is `contents` so the time is an
  unshrinkable item and the republishers an item of basis 0 - the author name shrinks only once
  they are gone. The repost glyph is `aria-hidden`; the words carry it.
- **An anonymous post or comment is NAMED "Anonyme" for every reader, with the mask avatar.** A
  reader the server sent the author's id to - `authorId` on a post (`mustHideAnonymousAuthor`:
  the author, a content moderator, a platform admin), `userId` on a comment (`serveComment`: the
  writer, a content moderator, a platform admin) - also gets ONE small line under the name: a mask
  glyph and the real name linking the profile (`RevealedAuthorLine`, mounted from
  `revealedPostAuthor` / `commentRevealedAuthorId`). "Anonyme" itself links nowhere. In the reel
  overlay that link is a 44 px row (`tall`) - not `tap-target`, whose enlarged box the truncating
  overflow would clip. Everyone else
  sees "Anonyme" alone. An anonymous comment stores no name, so the name is resolved from the id
  (`UserName`, the app's one id-to-name reader); a post's line paints its own name columns first.
  The media viewer's sender (`postAuthorName`) says "Anonyme" too, so it never disagrees with the
  header. This replaced the 2026-09-17 shape (real name and photo, an "Anonyme" badge by the time).
  Component tests per state: `PostHeader.anonymous`, `CommentItem.anonymous`, `CommentsPreview`,
  `ReelSlide`. **Read by tests only; no phone has looked at it.**

**The row is ONE floating glass pill, not a band (owner, 2026-10-31, iPhone: unequal margins, a grey
band "in the middle of nowhere").** The three tabs are a segmented control inside one `.glass-chrome`
pill (the conversation header's recipe and tokens: `--glass-chrome-*`, nothing new) and the CanaReels
entry is the matching round glass button (the `ui-icon-button` box: 44 px touch, 38 px pointer; the pill follows the same split with `h-11` and `md:pointer-fine:h-9.5`, never a size on the button itself, which `iconButtonScale.test.ts` forbids). The sticky wrapper has NO background and
no horizontal inset, so both edges are the feed column's own gutters and cards scroll under the glass;
it is `pointer-events-none` with its buttons `auto`, so the gaps stay the feed's. The glass is drawn at
every width, unlike the phone-only conversation chrome (`usesGlassChrome`), because on desktop the row
floats over scrolling cards too, and a desktop-only opaque twin would be a second look for one
control. The active tab keeps its amber fill, plus `font-semibold`; chips have the `tap-target` 44 px
hit box on touch. The reveal logic below is unchanged.

**The tab row collapses like Instagram's header (member report, 2026-10-22: the tabs were reachable
only at the very top).** The wrapper in `routes/posts/+page.svelte` is `sticky top-0` in
`.page-scroll-wrap` (the one scroller, at every width, so desktop behaves the same) and slides out
with `-translate-y-full` when `tabsShown` is false: a transform on one boolean, so nothing reflows
and the infinite scroll's position is untouched. The direction is read from that container's
`scrollTop` by `nextScrollDirection` ([`utils/scrollDirection.ts`](../../../../frontend/src/lib/utils/scrollDirection.ts)),
a pure step with an 8 px dead zone measured from where the reader turned; the row is always shown
at the top, and `scrollTop` is clamped to the maximum so a bottom bounce is not an upward scroll.
The handler is passive and logs nothing per event. `motion-reduce` drops the slide, `inert` keeps
the hidden row out of the tab order, and **the row never hides while focus is inside it**
(`focusin`/`focusout` drive `tabsFocused`): `inert` on a focused row would drop that focus to the
body. The direction is **seeded at the container's `scrollTop` at mount**
(`initialScrollDirection(top)`), not at 0, so a page restored mid-scroll does not read its whole
offset as one scroll down and hide the row unasked. **While a search replaces the feed** the row's
content is hidden and the wrapper is neither `sticky` nor padded, so no empty opaque band sits over
the results. Read by code and unit test only: no phone has looked at it (the tab swipe, #1223, is a
horizontal gesture on the same container and is not touched). **Owed ONE iPhone reading** (review,
2026-10-23): the row when the page header unmounts with the keyboard open.

## An anonymous poll stores a tally and no voters (2026-09-30)

A poll can be created **anonymous** (`PollInputDto.anonymous`), fixed at creation like a form's
(`normalizePolls` keeps the STORED value on an edit, so a request cannot flip it either way).
`apps/social-service/src/posts/anonymous-poll.ts` is the whole mechanism:

- **Stored**: `option.votes` is a NUMBER, and `poll.voters` is the list of accounts that voted, with
  no choice attached and **sorted**, so the list is not the order of arrival. `votesByUser` is `{}`.
- **Served**: `servePolls` drops `voters` and adds `voted` for THAT reader. It runs at the two
  points every served post goes through (`shapeListRow`, `toPublicPostFromEntity`), so a
  participant list is never sent to anybody - not the author, not a moderator.
- **The vote goes through the read's gate and the read's shaping** (2026-10-24): the route asks
  `PostsService.assertMayVote` (`assertOpenable`, the gate `getById` uses, with the vote's
  grant-free audience), then answers through `PostsService.serveToReader`, the shaping `getById`
  uses. A poll id the post does not have is a 404 (`posts.controller.vote-response.spec.ts`).
- **Final**: one vote, no change, no retraction. Changing a vote needs the previous choice, which is
  exactly what was not kept. The card therefore does not send an anonymous single-choice vote on the
  tap: it waits for the "Voter" button, as a multiple-choice poll does.

The price, stated: after a reload an anonymous voter sees THAT they voted and the results, but not
which option they picked - the server does not know.

## Who voted: a capped hover, and an info button that opens the full list (2026-10-24)

`PostPolls.svelte` is the ONE poll card, for a post poll and a channel poll (`ChannelPoll` wraps
it), so this is one implementation. The voter list used to be a hover tooltip on the vote count,
reached on a phone only by a long press (hard to hold without voting) and as tall as the voter list
(45 names overflowed the screen).

- **Hover (mouse only)** on the info button shows `POLL_TOOLTIP_MAX_VOTERS` (10) names, then
  "+ N autres personnes" (`post_poll_voters_more`, plural), and its `max-height` follows the room
  above the anchor. A touch pointer never opens it (`pointerType === 'mouse'`).
- **The info button** (Users icon, 44 px) is a SIBLING of the vote button, never a child: the old
  count badge was a `role=button` nested in the vote button and relied on `stopPropagation`. It
  opens `PollVotersSheet.svelte` - `Modal`, so a bottom sheet on a phone and a dialog on desktop,
  with the focus trap, Escape, the back gesture and focus return. The sheet scrolls and, with
  two options or more, switches option through a row of toggle buttons (`aria-pressed`; a `tablist` is reserved by `sectionMenus.test.ts`).
- **Anonymous polls and empty options get no button**: the server sends an anonymous poll no voter
  ids (a tally), and an option with 0 voters has nobody to list. The server is unchanged.
- Helpers (cap, name resolution) are in `posts/pollVoters.ts`.
- **Not verifiable without a phone**: the sheet's height and scroll under the keyboard-aware
  overlay, and that a scroll starting on the info button never votes (it cannot by construction -
  the button has no vote handler - but nothing here ran on the Mi 9T).

## Post creation (EditPostForm.svelte)

- Markdown content editor. **A body OR a media entry, and either is enough** - the client's
  `hasContent` and the server's `PostBodyOrMediaConstraint` (`post.dto.ts`, create and edit) say the
  same thing, whitespace counting as no body on both. Until 2026-10-02 the server said
  `@IsNotEmpty()` alone: a captionless photo or video was prepared, encrypted and uploaded, then
  refused with `markdown should not be empty` - read on the Mi 9T while proving CanaReels R2.
- Optional image upload. **Encrypted like any other media** (`encryptAndUpload`, per-file CEK, the
  key travelling in the post row) and marked `retentionClass: 'archive'` so the media service's idle
  sweep never takes it — see
  [media-service](../../services/media-service.md#the-archive-class-the-feed-is-not-a-conversation-2026-09-23).
  This line claimed the opposite until 2026-09-23: *"CEK not used here — public media via
  `POST /api/media/upload/public`"*, a route only `AssociationsService` has ever called. Read
  literally it said a post image was permanent, which is the one thing it was not.
- Optional poll (question + options).
- Optional embedded form (link to an association form).
- Optional scheduling (publish at a future time).
- Publish on behalf of an association (if admin with `MANAGE_ASSO`).

### The composer's layout: full screen, the text taking the height, the actions under the thumb (2026-09-29)

Compared on the Mi 9T with Facebook's and Instagram's composers (the user's decisions C1-C10, and
the stages still open, are in [backlog](../../backlog.md#the-composer-and-canareels-chantier---compared-on-the-mi-9t-2026-09-29-every-decision-taken)).
What it was: a modal over the feed holding three nested bordered boxes, three titles saying the
same thing, a full-width "Publier en tant que" select, eight Markdown buttons on two rows above an
empty field, four unlabelled icons, and "Publier" ABOVE them. The measurement it was taken from:

| | Facebook | Instagram | Canari before R1 |
| --- | --- | --- | --- |
| Frame | Full screen, one title | Full screen | A modal over the feed, three nested bordered boxes |
| Author | Avatar + name, one line | - | A full-width "PUBLIER EN TANT QUE" select |
| Text area | The whole screen, borderless, no toolbar | - | ~250 px, boxed, behind 8 Markdown buttons on two rows |
| Primary action | "Suivant", bottom right, disabled while empty | "Suivant", top right | "Publier" ABOVE the attachment bar |
| Attachments | Labelled chips + a pinned bottom bar | Gallery grid, camera as the first tile | Four UNLABELLED icons |
| Adding a photo | Full-screen photo grid | same | Android's generic DocumentsUI, because one input's `accept` listed images, video, audio, PDF, Office and zip together - hence Photo/video and Fichier are two inputs now |
| Camera | From the gallery | `+`, or a swipe right from the feed | None |

- **`Modal`'s `phoneFullScreen`**. Below `sm` the panel covers the screen edge to edge and the body
  is handed over unpadded and unscrolled. The overlay already follows the visual viewport, so a
  panel that fills it has its bottom edge on the keyboard: `CreatePostForm` is a scroll region plus
  a footer, and the footer sits on the keyboard with nothing computed. The rules are
  `.modal-phone-full` in `app.css`, which lift the 1rem moat and the `92dvh` cap and move the safe
  areas onto the panel.
- **The author is one line.** The avatar of the chosen identity, and the "who is publishing"
  `<select>` drawn AS the name - its personal option carries the member's own name, not "Profil
  personnel".
- **`PostComposerBar`, shared by the composer and `EditPostForm`.** Row one: labelled chips
  (Photo/vidéo, Ouvrir la caméra, Sondage, Formulaire, Fichier, Programmer). Row two: "Aa",
  a status, and the action. **Markdown stays** (user) and "Aa" swaps row one for the formatting
  row: a pinned bar above the keyboard cannot afford a third row. The field is driven through
  `MarkdownComposerField.format()`, and the toolbar prevents `mousedown` so a tap keeps the caret
  and the keyboard.
- **Two file inputs, because the accept list chooses the chooser** (it was four until 2026-10-11).
  One input taking images, video, audio, PDF, Office and zip is what made Android open its generic
  file browser instead of the photo picker, so photos/videos and documents have one each.
  **There is NO capture input and no system camera (user, 2026-10-11, D-camera).** The ONE camera chip
  ("Ouvrir la camera", not drawn for a fine pointer) opens the in-app CanaReel camera as an overlay
  (`CameraOverlay`, `ReelCapture` with `destination="post"`): a PHOTO taken there comes
  back as a file through `onFiles` and is attached - and retained - as any picked post media, with
  the POST class, never as a reel. **A VIDEO filmed there is a CanaReel since 2026-10-19** (user:
  one camera, one behaviour): it goes to the reel publish step with the composer's text as caption,
  that step says it is deleted after 30 days, and "Garder comme post" hands it back here as an
  ordinary attachment, with the caption and identity as edited there. A new post with a schedule, a
  poll, a form or a linked event keeps the old outcome (a reel carries none of them): its camera
  attaches the video. A video picked from the gallery stays a post, and the post EDITOR's camera
  (`destination="post-edit"`) attaches videos too - an existing post never becomes a reel
  ([reels](reels.md#the-two-ways-into-the-camera-publish-the-same-thing-2026-10-19)). The
  sound-removal button and the gallery shortcut of the reel flow are not offered there. **The post camera asks the lens and the microphone as TWO requests**
  (`postCameraOpener`, PR #1859 review 2026-10-15; one opener per camera session, which does not ask again after a refusal, so a lens flip asks nothing): one combined request made a refused microphone a
  refused camera, so a post took no photo either. A refused microphone leaves a live camera with no
  audio track: every press is a photo, said once ("Micro indisponible : photos uniquement"). A cap
  not yet read (offline) disables only the video, never the photo. **In the iOS app "Photo/video" is
  the native photo library** (`opensNatively` + `pickNatively`, as the chat's "Phototheque"): a file
  input accepting images or videos is answered by WebKit's sheet, whose "Prendre une photo ou une
  video" IS the system camera. The documents input stays an input: no image or video in its accept
  list, so WebKit opens the document picker directly. The Android manifest lost its `<queries>` for `IMAGE_CAPTURE` /
  `VIDEO_CAPTURE` and the FileProvider its `Pictures/` root; `androidCaptureManifest.test.ts` pins
  their ABSENCE. **Every pick ADDS**: each input empties itself after handing its files over, so a
  PDF added after a photo no longer replaces the photo.
- **A picked video shows its first frame** (`PickedMediaPreview`, both forms). Every previewable
  pick used to go into an `<img>`, so a video - gallery or camera - drew a broken image, and an
  audio file did too because `needsThumbIcon` only iconised `'file'`. Only a picture or a video has
  a frame now; everything else is the icon card.
- **The error banner is in the footer**, above the bar, so the keyboard cannot cover it.
- **One caption field, opened from its photo** (user, Mi 9T: *"A-t-on besoin d'un 'Legende
  (opt.)' ?"*). An input under every thumbnail put four empty boxes under a four-photo post. The
  feed prints a caption under its photo, so it stays - behind a `MediaCaptionChip` in the thumbnail's
  corner, which opens ONE `MediaCaptionField` under the strip and turns amber once that photo has a
  caption. The field is keyed by index, so `shiftAfterRemoval` moves it with its photo when an
  earlier one is removed instead of re-pointing it at the next.
- **No chip wears a ring after a tap.** The ring was `focus-within`, and a file input keeps focus
  once its chooser closes, so the last chip tapped kept a halo, cut flat by the scrolling row. It is
  `:focus-visible` now (keyboard focus only), asked of the input through `has-`.
- **Who publishes, and the linked event, are the app's own `Picker`** - a bottom sheet with avatars
  on a phone, a popover on a wide window - never a native `<select>`, which on Android opens the
  system's dialog of bare names (user: *"il ne vaut mieux pas sortir de l'experience de
  l'application"*). The rule is app-wide, in [durable-rules](../../durable-rules.md#ui-and-i18n---frontendarchitecture-auth-native-prompts).
- **So is every date**: the schedule chip, a poll's deadline, a form's opening, an event's start
  and end are `ui/DateTimeField` - a month grid with hour and minute columns, a draft until
  "Valider". The schedule chip's minimum used to be `toISOString().slice(0, 16)`, a UTC time read
  as local, so in Paris it refused the next two hours; it is `toDatetimeLocalValue` now.
- **A video in the feed plays like Instagram's** (user, Mi 9T: *"L'affichage actuel est assez moche
  non ? Je veux un truc joli comme instagram"*). It drew the native controls - Android's grey bar -
  inside a 16:9 box of its own, a "Plein ecran" pill and a download button over it, and a phone's
  vertical clip became a strip between black bands over a grey one. Now `preparePostMedia` records
  a video's `width`/`height` at upload (the on-device encoder's own output since R2,
  [video-preparation](../video-preparation.md)), so `PostContent` reserves the box
  at the clip's own shape; the video is CONTAINED in it (`object-contain`: the WHOLE
  frame at the clip's own ratio, never cropped - user, 2026-10-22, a portrait clip past the
  `--media-max-height` ceiling used to lose its top and bottom). The bands the ceiling leaves on the
  sides are a blurred copy of the clip's own first frame, the picture post's backdrop
  (`BlurredBackdrop`): `InlineVideo` draws the frame it already decoded ONCE into a 48 px canvas
  (`captureVideoFrame`) - no second `<video>`, no second stream, one `drawImage` and a few hundred
  bytes - and until it exists the box is the neutral `bg-cn-surface` under the usual poster. A reel
  goes through the SAME box (`singleMedia`), with a 9:16 fallback when it carries no dimensions. The
  square gallery cell still crops (`videoFit="cover"`, its shape being the point). It plays muted on its own (`InlineVideo`, rule in
  [durable-rules](../../durable-rules.md#ui-and-i18n---frontendarchitecture-auth-native-prompts)).
  The download lives in the viewer. A video posted before this carries no dimensions and keeps the
  4:3 box, contained the same way. Measured on the Mi 9T: a 1080 x 2340 clip in a 402 x 567 box,
  playing, looping, silent at every start until its button is pressed, then audible on every video
  at once; the viewer opening PAUSES the feed's video and closing it resumes it - before that rule
  the two played together, sound on both.
- **A segmented video can play before it has finished downloading** (CanaReels R2, reader only):
  `PostMedia` streams it through MSE when its ref is segmented and names its codecs, and reads it
  whole otherwise - every video posted today. The format, the choice and the writer flip it waits on
  are on [media-service](../../services/media-service.md#segmented-media-play-while-downloading-canareels-r2---the-reader-release-2026-10-01).
- **No stray logo before a video's first frame** (user, Mi 9T: *"un logo bizarre qui s'affiche avant
  que la video ne charge"*, also on every swipe back to the feed). Filmed at 60 fps it was TWO
  things. The loading placeholder drew a camera icon over media already decrypted in memory, because
  a rebuilt feed waited one frame for its `nearViewport` observer before asking -
  `retainWarmDecryptedMediaBlobUrl` now answers synchronously and deferring only holds a COLD media
  (it exists to spare the network). And the Android WebView draws its own default poster, a large
  grey play button, until a frame is decoded - `object-cover` blew it up to the whole card - so a
  video that plays by itself carries `TRANSPARENT_VIDEO_POSTER` (`utils/videoPoster.ts`), and the
  box's black shows instead. The composer's paused preview keeps no poster: one would hide the
  first frame `#t=0.1` decodes.

## The header's Publish and search are commands, stripped BEFORE they act (2026-10-28)

The phone's app header reaches the feed with a link: `/posts?compose=1` (Publish) or
`/posts?search=1`. The feed strips the parameter with a `goto(..., { replace: true })`, so no
history entry carries it, and only then opens the composer or the search field.

The order is the whole fix. The strip is a navigation, and the root layout's `beforeNavigate`
closes every open overlay first (`drainHistoryOverlayStack`). Kit 2 kept the arriving navigation
open through `await commit_promise; await tick(); await tick();`, and `_before_navigate` skips every
callback while one is open, so a strip fired by the arriving page ran no hook and drained nothing.
Kit 3 ends the navigation as soon as the page has settled (`finish_navigation`), so the strip runs
the hooks. Since #2613 a composer opened in the same tick was therefore closed as it opened. A
replace issued while an overlay's own history entry is under the pointer would also overwrite that
entry: a second reason to strip first.

Whether the strip landed is read off the page, never off the error. Kit rejects an overtaken
navigation with an untyped `Error('navigation aborted')`. A strip overtaken by another navigation
drops the command with an info line, and only a strip that failed on the feed itself is logged as
an error.

On the Mi 9T the sequence was read over CDP: the overlay pushed at 130 ms, the dialog mounted at
134, unmounted at 164 with no popstate, and the router's replace at 180, which also overwrote the
overlay's own history entry. No Live chip could be reached, so LIVE-WEB-2 and LIVE-STALL-1 could
not run. The search field is not an overlay and was never closed.

`page.feedCommand.svelte.test.ts` mounts the route with a `goto` double in kit 3's order (a
microtask, the drain, the new URL). It fails on the old order. It cannot see the real router or
the WebView's history: the phone reading is what proves the router keeps that order. The drain now
logs how many overlays a navigation closes, which was silent.

## Key components

| Component | Role |
|---|---|
| `posts/+page.svelte` | Feed page with tabs, search, infinite scroll |
| `posts/[postId]/+page.svelte` | Single post detail page |
| `CreatePostForm.svelte` / `EditPostForm.svelte` | Create / edit a post (markdown, media, poll, form, schedule) |
| `PostComposerBar.svelte` | The shared bottom bar: attachment chips, the formatting row, the action |
| `PostCard.svelte` | Post card in the feed |
| `PostReactions.svelte` | Emoji reaction bar |
| `PostComments.svelte` | Comment thread + composer (text, mentions, image/GIF) |

### Why the feed reads `postsOverride` OUTSIDE the `{#await}`

`load` returns `posts: listPosts(...)` **unawaited** — a streamed promise, so the page renders while
it is still in flight. The consequence is a Svelte semantic worth knowing before writing any
`{#await}` over route data: **a promise that has REJECTED stays rejected, so the `{#await}` sits in
`{:catch}` for the life of the component.** Nothing re-enters `{:then}`; only a new promise does,
which in practice means a remount.

That is what made the feed's "Réessayer" dead. `refreshPosts()` writes `postsOverride`, and the
template read it only as `postsOverride ?? initialPosts` **inside `{:then}`** — unreachable exactly
when the retry mattered. Measured on device: the retry's own fetch returned `200` in 326 ms and the
error screen stayed up with zero cards. Leaving the page and coming back worked, which is why the
whole thing read as a network problem (it was not — `/api/version` and `/api/posts` both answered
200 from the same WebView at the time).

So the list rendering lives in a `feedList` snippet consulted **before** the await:

```svelte
{#if postsOverride}{@render feedList(postsOverride)}
{:else}{#await data.posts} … {:then initial}{@render feedList(initial)} {:catch} … {/await}{/if}
```

The generalisation, which applies to every retry in the app: **state a retry writes must be read
from outside the thing that failed.** A retry whose result is only consulted on the success path of
the failed attempt cannot work by construction.

**This class is not unit-testable here** — the defect is purely *where* the template reads its
state, and the repo has no component-rendering setup.
`tools/cross-client-harness/check-feed-retry.mjs` covers it, injecting a one-shot `/api/posts`
failure and asserting the retry both fetches and renders. Verified on device: the error screen and
its button are gone and two cards are back, against a build where the same injection left the error
screen up after a `200`.

## Who sees which control: three served booleans, never `authorId`

`PostOverlayControls` draws every gate from a boolean the SERVER answered for this reader -
`canManage` (pencil, bin), `canPin`, `canReport` - and derives none of them. It cannot: an
association post is served with its `authorId` removed, so the comparison the card used to make
(`authorId === currentUserId`) was against a field that is absent precisely on the posts an
association's officers manage - nobody but a platform admin could edit them, and the absence of a
button raises nothing anywhere. Nothing in a post says whether its reader moderates the feed either,
which is why the pin followed `isGlobalAdmin` and a BDE `MODERATE` holder never saw it.

**Three fields rather than one, because the three controls do not share a rule**: a moderator edits,
deletes and pins what it did not publish and may still report it; an association's officer edits and
deletes its own, pins nothing, and has nobody to report itself to. The tiers and the predicates
behind them are on
[association-permissions](../../association-permissions.md#a-right-the-client-cannot-compute-the-capabilities-served-on-a-post).

Consequence for any new post surface: it must fetch its posts through an endpoint that carries the
viewer (`GET /api/posts`, `/api/posts/search`, `/api/posts/:id` all do), or every card it renders
will be read-only. And a response that merges into a card - `onPostSaved` does exactly that - has to
carry the three too, or saving an edit removes the control that started it.

**What a "no bin on my own post" report has already been read against (user, 2026-09-17, a post
published as an association, on prod).** `createPost` used to stamp its response with
`isGlobalAdmin: false`, so a global admin posting as an association got its own post back
`canManage: false` - fixed. But `CreatePostForm` discards that response and refetches the feed, so
that defect was invisible to this client. Ruled out by reading: the feed passes the real admin flag
and stamps every row through `shapeListRow`; `getById` passes its own; the feed cache is keyed per
reader; `PostCard` reads `canManage` straight from the response; and `viewerIsPublisher` resolves an
association post through `POST_AS_ASSO` for creation and management alike. What would settle the
report is the post itself: whether its publisher held `POST_AS_ASSO` on that association, or reached
the composer through the global-admin route alone.

## Asking the author of a personal post (D38b, 2026-10-19)

A personal post is carried by an association only with its author's consent; the decision, the
refusals and the proof are on
[profiles-and-access](../../profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built).
On the card, three served fields:

- `canRequestRepublication` draws "Republier au nom d'une association", which opens
  `RepublishDialog` in `request` mode (`personalRequestCandidates`).
- `republicationRequests` draws "Demande envoyee au nom de X" under the header and "Annuler la
  demande de X" in the menu (`withdrawProposal`).
- `canUnrepublishAs` lists EVERY republisher for the post's author, who may withdraw any of them.

A refused request is read by its typed `code` (`personalRequestRefusalMessage`), never its message.
The author answers in `/notifications/requests`, reached from the notification, its push
(`fr.emse.canari://republication-requests`) and a link on `/notifications` while one waits.

## The search stops where the feed stops (2026-10-04)

`/api/posts/search` is ONE server query - `ILIKE` over the body and the association name, pinned
then newest first, 20 rows - and it owes every exclusion the feed applies, because a hit renders
the same card as a feed row: report-hidden posts, the store-review account, live reels, blocked
authors, **and the viewer's promo cutoff** (`promo-visibility.ts`: nothing before the August their
promo opens on, no limit for a global admin or a row with no promo). The cutoff was the one missed,
and the user found it (2026-08-23: *"la recherche desactive les filtres ?"*). It is a RELEVANCE
limit, not a confidentiality one, so its absence was an inconsistency and not a leak. The tab and
kind chips are a reader's choice and are hidden while a query is typed, so they do not apply.

## A body made of Markdown cannot hold an image, so nothing but text is ever put in it

`MentionComposerInput` is the ONE `contenteditable` in this repository - the post composer, the post
editor, the comment box and the chat composer all mount it - and until 2026-09-18 it left paste and
drop to the browser. The browser's default for a `contenteditable` is to insert the clipboard's
`text/html`, so an image dropped into a post body rendered on screen, and
`serializeMentionEditor` - which keeps text, `<br>`, block boundaries and mention chips, and walks
THROUGH everything else - dropped it silently on save. The reader was shown something the document
could not hold, and found out by publishing (user, 2026-09-18: *"ce qui n'est evidemment pas
sauvegarde ... du coup ca ne devrait meme pas etre possible"*).

**Across an origin it is worse than a disappointment.** Copying a picture out of a Messenger tab
puts no file on the clipboard at all - only `text/html` naming `blob:https://www.messenger.com/...`,
which only the page that created it may read. Inserting that markup made the browser refuse the
load with a security error the reader could do nothing about.

**The rule is now one sentence, and it lives on the editor rather than on each of its five
callers**: the default is refused unconditionally, files go to `onmedia`, and everything else is
inserted as `text/plain`.

| what arrives | where it goes |
| --- | --- |
| a dropped or pasted FILE | `onmedia(files)` - the caller's attachment list, exactly where its own media button delivers |
| rich text | its `text/plain`, so the words survive and the styling a Markdown body cannot represent does not |
| foreign markup with no file (the Messenger case) | nowhere, and a log line saying so - there is no file to rescue |

`onmedia` is optional: a composer with no attachments (a comment box) still gets the refusal, which
is the honest outcome. `filesFromTransfer` in `$lib/utils/composerTransfer.ts` is what reads the
payload, and it reads `files` AND `items` because the two disagree - a drop fills the first, a
pasted screenshot only the second. `ChatComposer` had one collector for each event, each correct
only for its own; both are gone.

`MentionComposerInput.transfer.svelte.test.ts` pins the properties on the editor's own DOM rather
than through the serialiser, because the defect was visible on screen before anything was saved.

### The filler holding the caret must be the character the serialiser strips

Pasted text is inserted by hand, so a paste ending in a newline ends the fragment with a `<br>` -
and a caret placed after a trailing `<br>` anchors to the PARENT and types before it, not after.
One zero-width space is appended to give the caret something to sit in, and
`stripComposerDomFillers` removes exactly U+200B on the way out. That makes the IDENTITY of the
character load-bearing: anything else put there is not a filler, it is content, and it reaches the
sent message.

The first version of this insert carried the mojibake of U+200B - its own UTF-8 read as Latin-1 and
re-encoded, three visible characters the stripper does not match. Both filler sites in the component
now use `COMPOSER_EMPTY_LINE_FILLER` from `$lib/utils/mentions/mentionEditor`, the same export the
stripper is written against, so the two cannot drift apart again. The test asserts against that
constant rather than against "some invisible thing", which is the only way the difference shows up
in a diff at all.

**Invisible to the eye, never to the caret - so every key that crosses it is handled by hand.**
The browser counts the filler as a character. Native Backspace deleted the filler and left the `<br>`
(then doubled it), which is why `removeNewlineFillerBeforeCursor` removes both at once. The arrows had
the same defect until 2026-09-26 (user: *"I have to press left arrow two times to get back to the line
before"*): the caret sits AFTER the filler, so the first ArrowLeft crossed it and moved nothing on
screen. `stepOverFillerBesideCaret` now moves the caret (or, with Shift, the selection's focus) past
the filler run and leaves the key's default to take the one visible step - measured in Chromium, one
ArrowLeft then types at the end of the line above (`helloX<br>`) where it used to type at the start
of the new line (`hello<br>X`). Ctrl/Alt/Meta jumps stay the browser's.

**And every EMPTY line carries its own filler, with the caret inside text - Firefox demands both.**
Pressed on an empty line, `insertNewlineAtCursor` split in front of that line's filler, pushed it down
with the caret and left `a<br><br><br>` behind, the caret at the parent's child index. From there
Firefox moved two lines or straight to the top (measured 2026-09-26 on Firefox 155, user: *"pressing
left should bring me up one line, not to the top"*); Chromium happened to cope. The insertion now puts
the caret inside the text it splits off, and `anchorEmptyLineBefore` refills the line it leaves -
the shape `renderMentionEditor` already draws. Measured in both engines on the real component:
Shift+Enter three times on an empty composer, then each ArrowLeft/ArrowRight moves one line.

## "Voir plus" clamps the rendered post, and never cuts its Markdown (2026-09-28)

`PostContent` used to cut a long post at 400 characters of SOURCE and render the cut. A cut inside
`**gras**` left an unmatched `**` on screen, and the emphasis appeared only once "Voir plus" revealed
its closing pair (user, 2026-09-28) - the same for a link, a code block or a table. The post is now
rendered WHOLE and clamped by lines (`line-clamp-8`), the way `PostComments` always clamped a
comment (`line-clamp-5`), so no syntax can be broken by the fold.

**The button is a MEASUREMENT, not a length.** A `ResizeObserver` compares the box's `scrollHeight`
with its `clientHeight` while clamped, so a long post that fits shows no button and a short one that
wraps into nine lines does. It measures only while clamped: expanded, the box reports no overflow and
would hide the "Voir moins" that folds it back. The cut is therefore at a line and not at a character
count. Measured on Chromium and Firefox at 390px, across a heading, paragraphs and a list: eight
lines ending in `…`, the bold rendered, no raw `**`. **WebKit is not measured** (no engine here);
`-webkit-line-clamp` originates there. `PostContent.seeMore.svelte.test.ts` fails on the old cut.

## A post's text could not be copied on a phone, because nothing marked it as content (2026-09-29)

Reported from the app: *"on ne peut pas copier le texte dans les posts (ce qui peut etre utile pour
recuperer une info)"*. Not a post-specific defect: `app.css` INVERTS `user-select` under
`@media (pointer: coarse)`, because a long press was selecting navigation labels and setting
descriptions - and the opt-in it left is Tailwind's `select-text` written at a call site. Exactly one
call site ever wrote it, the chat message body. Everything else rendered from Markdown - a post, a
comment, a profile bio, a partnership description - was chrome as far as a thumb was concerned.

**The opt-in is `.post-markdown` in the stylesheet, not four class attributes**, for the same reason
the list and blockquote rules live there: a rule written into one class string is a rule the other
three surfaces cannot inherit, which is precisely how the list markers went missing on the most-read
surface in the app. `user-select` inherits, so the block's descendants come with it, and a mouse drag
on a desktop was never affected - the media query is the whole scope.

## Attachment layout (PostContent / PostMedia)

A post attachment is decrypted client-side, so its container has to hold a shape before the bytes
arrive. That reservation is per media type, not universal — `reservesAspectRatio` in
`utils/mediaLayout.ts` is the single decision, and `resolveMediaType` is the single
explicit-type-then-mime fallback:

- **image / video** — the container sets `aspect-ratio` (from `width`/`height`, else 4:3) so the
  feed does not jump when the media lands. `PostMedia` fills it with `absolute inset-0`
  placeholders.
- **file / audio** — no reservation: the card sizes itself. A document has no `width`/`height`, so
  reserving would apply the 4:3 fallback and strand a ~70 px card in a ~430 px box. Its skeleton
  and its error box must therefore be in the flow, not `absolute` — a parent with no reserved
  height renders an absolutely-positioned child as nothing, including the decrypt-failure state.

**The reservation also carries a CEILING, and that is the half that keeps a feed scrollable.** The
ratio is clamped to `[0.25, 4]`, which still allows a box four times the card's width - about two
phone screens of a single picture - so `mediaAspectStyle` emits `max-height: var(--media-max-height)`
(80svh, defined once in `app.css`) alongside the `aspect-ratio`. Past the ceiling a PICTURE or a
VIDEO is no longer cropped: both are contained over a blurred backdrop (see the video paragraph
above). **The crop below is the one that remains - the gallery cell's, and it is CENTRED** (`object-cover object-center`): the ceiling was
first shipped with a top anchor, on the argument that a screenshot or an infographic says what it
has to say at the top - but a post attachment is overwhelmingly a photograph, whose subject is in
the middle, and a top anchor reads as a bug on one. The full frame is one tap away in the viewer,
which is what makes cropping right here. A chat image (`MessageMediaRenderer`) is centred by the
same argument. The only `object-top` anchors LEFT are the three `PdfThumbnail` call sites, and they
are not an oversight: a 44px square cover-crop of an A4 page shows its title at the top and a strip
of one paragraph at the middle, so a document is the one attachment whose top IS its identity.

Two unit choices in that token are deliberate and neither is cosmetic: `svh` rather than `dvh`, so a
collapsing mobile URL bar does not re-lay-out the feed under the reader's finger; and NOT
`--app-viewport-height`, which tracks the soft keyboard - a picture must not resize because someone
started typing. Because the ceiling lives in the shared helper, the feed, the gallery cells, a
comment image and a chat bubble are bounded by one decision instead of four local patches.

### The card's spacing, read on the Mi 9T (2026-10-01)

Four changes from one reading of the feed on the phone, each measured at 436 px in Chromium first:

- **An empty comment section is a composer and nothing else.** Opened on a post with no comments,
  the input sat 45 px under the action row: the section's `py-4` (16), the EMPTY list's `mb-4` (16)
  and the input area's `pt-3` (12) - spacing between a list and the composer, drawn with no list.
  Now the list element exists only when it holds something, the section pads `pt-2 pb-3`, and the
  input pill dropped from 58 px to 50 (its 44 px send target sets the height). Measured after: 9 px.
  `PostComments.empty.svelte.test.ts` pins the cause, since happy-dom lays nothing out.
- **One separator, not two.** `PostActions` carried a `border-b` that sat one pixel above the
  comment section's `border-t`; it is gone, and the row's first glyph lands on the text's 20 px.
- **The picture is inset and rounded.** The media block pads `px-3` and the box is `rounded-lg`:
  18 px card corner, 12 px inset, 8 px media corner - the concentric pair, and the scale's card
  corner. **It is padding on the block, never a margin on the box**: the box's width would then come
  from `aspect-ratio` under the `max-height` ceiling, and a portrait video SHRANK to 270 px wide
  instead of being cropped (seen in the first draft).
- **The card stands off the page**: `shadow-md` at 8 % in light; in dark mode, where a shadow has
  nothing to fall on, the edge goes from 10 % to 15 % white.

**The video sound button was green** while the app is amber. It was 55 % black over a backdrop
blur, which takes the hue of the frame under it. It is now an amber glyph on a near-opaque
`--color-cn-scrim` while muted and a solid `--cn-yellow` disc once the sound is on.

### Several media: square cells, and a "+N" past four (2026-10-05)

Decided by the user with a screenshot: a post of several pictures was a two-column grid whose
cells kept each picture's OWN shape (#1378 had dropped the square cells), so a landscape photo
beside a portrait one left a blank area under the shorter one. The gallery is now the
Facebook / Instagram / Messenger shape, decided by one pure helper,
`postGalleryLayout(count)` in `utils/posts/postGalleryLayout.ts`:

| Pictures and videos | Layout |
| --- | --- |
| 1 | drawn at its own shape, exactly as a single-attachment post (`singleMedia` snippet) |
| 2 | two squares side by side |
| 3 | `feature`: a 3x2 grid, the first cell spanning 2x2 - one large square, two stacked squares |
| 4 | a 2x2 |
| more | the first four in the 2x2, the fourth under a `cn-scrim` veil saying `+N` (N = total - 4) |

- **Three is the large-plus-two shape, not three in a row**: a row of three gives each picture a
  third of a 390 px card, about 120 px, too small to read.
- **Every cell carries `aspect-square`, the spanning one included.** Its height then comes from
  its width and never from the picture, which would otherwise stretch the rows it spans. A square
  also has a height known before any download, so the gallery reserves its exact box and nothing
  under it moves when the pictures land - `mediaAspectStyle` is no longer asked for a cell.
- **The cells are drawn FROM `lightboxMedia`**, the list compacted to image/video, so a cell's
  position IS its viewer index and a document cannot renumber the pictures after it. The `+N` cell
  opens the viewer at index 3, and the viewer moves through all of them.
- **Files and audio are never cells**: they are rows under the grid, each drawn by the same
  snippet as a single attachment, caption included.
- **A video cell passes `letterbox`**, which for a clip means "fill the caller's box, cropped";
  without it `PostMedia` draws its own 16:9 card inside the square.
- The per-cell caption overlay is kept, and hidden under the `+N` veil.

The chat has no equivalent grid (one attachment per message), and the composer's previews are
already fixed `aspect-square` thumbnails in a scrolling row.

## PDF previews, and the in-app reader

`utils/pdfDocument.ts` is the one pdf.js seam: it loads the library once, opens a decrypted
document, and rasterises any page into a detached `<canvas>` (a render that can be cancelled).
`PdfThumbnail.svelte` (page 1 only, encoded to a WebP object URL by `canvasToBlob`) and `PdfViewerModal.svelte` (the
whole document, canvases shown as they are) both go through it. Two constraints fix this design:

- **No server-side thumbnail is possible.** Media is encrypted with a per-file CEK before upload;
  the backend only ever holds an opaque blob.
- **No `<iframe>` either.** Desktop browsers and iOS WKWebView render a PDF natively, Android's
  WebView does not — it would be blank on the main mobile platform. Rasterising is what lets one
  component serve web, Android, iOS and desktop identically.

pdf.js and its worker load through a dynamic `import()`, so they stay out of the main bundle. The
preview is a bonus and never a gate: on any failure the file icon and the download button remain.
A post renders the page full-width under the file row; a chat bubble uses the 44 px icon square.
List surfaces that do not decrypt their files (`ConversationMediaPanel`, `AssociationDocumentManager`)
are excluded on purpose — previewing there would mean downloading and decrypting every listed
document, and a password-protected vault document cannot be decrypted at all without its password.

**The whole card opens the reader**, header row and preview alike — a preview nobody can click is
decoration. The download button is carved out of that area, which is why the clickable region wraps
the row's *content* rather than the row (a `<button>` inside a `<button>` is not markup), and the
preview repeats the header's action with `tabindex="-1"` rather than adding a second tab stop.

Things in `PdfViewerModal` that are not obvious, each of which produced a blank, flickering or
frozen viewer before it was right:

- **Its effects must depend on the document URL, and on the render width, and on nothing else.**
  Reading the page arrays inside either one makes every arriving page re-run the teardown, which
  frees the canvases currently on screen. Both read them under `untrack`.
- **The document handle is `$state.raw`.** A `$state` handle is a deep proxy, never `===` the raw
  handle the render queue holds, so every finished render was dropped as belonging to a closed
  document - the first build of the 2026-10-11 rewrite rendered nothing at all.
- **The old bitmap is never taken off screen.** A zoom leaves every bitmap the wrong size; it stays,
  stretched by CSS (each canvas is `width: 100%` of a column that widens), and is replaced in place
  when the sharp one lands. An old bitmap is the right image at the wrong resolution, strictly
  better than a blank or *cut* page (the placeholder is an `aspect-ratio` box with
  `overflow-hidden`). `tools/cross-client-harness/archive/check-pdf-render.mjs` measured that rule:
  **473 blank-or-cut frames out of 475 before it, 0 out of 474 after**.
- **The re-render guard is the CSS width a page was rendered FOR, tracked in `renderedAt`.** It
  cannot be read back off the bitmap, whose size is in DEVICE pixels and capped by the pixel budget.

### Making the reader fluid on a phone (2026-10-11)

Asked by the owner on a scanned 81-page magazine (14 MB, one 1240 x 1754 JPEG per page behind a
Flate filter, an OCR text layer). Measured on the Mi 9T with the REAL reader component, served to
the app's own WebView over `adb reverse` from a temporary route, old and new builds through the
same scripted pass (renderer RSS sampled from `/proc`, frames from an in-page `rAF` probe and
`dumpsys gfxinfo`):

| | before | after |
| --- | --- | --- |
| first page after the blob is ready | 4.96 s | 0.65 s |
| landing page after 7 flings to the end | white for 28.9 s | 43 ms |
| main-thread long tasks during that fling | 151, 32.5 s, longest 1.26 s | 22, 1.8 s, longest 0.14 s |
| one zoom click (x3 walk) | 25-27 s long task each | longest 0.5 s, sharp page 57 ms after the last click |
| renderer RSS peak over the pass | 1.82 GB (one run CRASHED the renderer, `code 5`) | 0.70 GB |

What each number came from, and the fix that bounds it:

- **`canvas.toBlob` for PNG or JPEG waits for an idle main thread.** The reader used to encode every
  page to a PNG for an `<img>`. On the phone the same `toBlob` took 150-350 ms on a quiet page and
  **4.07 s** while the reader scrolled, for a 1040 x 1470 page and a 109 x 154 thumbnail alike,
  when the render itself took 55-83 ms; WebP took 360-470 ms. Pages now stay canvases (no encode,
  no decode, the pixels held once); the thumbnail goes through `canvasToBlob` (`toDataURL`), the
  same cure the camera took on 2026-10-07 ([reels](reels.md)).
- **Nothing was ever cancelled.** A fling queued a render for every page flown past (57 of them),
  and the page the reader landed on waited behind all of them. `utils/pdfRenderQueue.ts` runs at
  most two renders, visible pages first, and cancels (`RenderTask.cancel`) a render whose page left
  the window. The caller re-states WHAT it wants on every change; the queue decides what to start,
  keep or cancel. Pure and unit-tested.
- **The "near" window did not exist.** The observers were rooted on the viewport, and a page below
  the scroll container's visible area is clipped by the container before the root margin applies:
  `rootMargin: 100%` did nothing and every page started rendering once already on screen. They are
  rooted on the scroll container now.
- **Memory had no bound.** Every bitmap was kept, and pdf.js kept every page's decoded image (8.7 MB
  each here). Now: a per-page cap of 6 MP (a x3 zoom asked for 8 MP, 32 MB, per page), a 96 MB
  budget over sharp bitmaps with farthest-first eviction (never a visible page), and
  `page.cleanup()` when a page leaves the window or is evicted.
- **A page is never blank for more than one cheap pass.** Each page first gets a ~60 000-pixel
  PREVIEW (~240 KB), then its sharp bitmap. Previews have their OWN budget, 24 MB (about 100
  pages), evicted farthest from the reader first: a page scrolled back to inside it is blurry rather
  than white, one further away re-renders its preview. Unbounded, a 600-page document read to the
  end would hold 144 MB of previews, and WKWebView kills canvas allocation past a total
  (`WEBKIT_CANVAS_MEMORY_LIMIT`, set at 384 MB here, conservative for an iPhone 12); the three
  pools (sharp, preview, in-flight) are tested to stay under half of it.
- **Zoom is a CSS stretch, then one sharp render.** The render width the queue plans against is a
  SETTLED width (`SettledWidth` in `pdfRenderQueue.ts`), written only 250 ms after the zoom stops
  moving - the queue never reads the live width, so a click mid-walk starts no sharp render and
  walking 1 -> 1.5 -> 2 -> 3 costs exactly one; coming back to the settled width before the timer
  fires costs none. Pages off screen keep their stretched bitmap until they scroll in. The
  two-scale scheme (`RENDER_ZOOMS`) went with the pixel cap that made it unnecessary.
- **The text layer was the zoom freeze.** `PdfTextLayer` fitted each span with its own action - a
  transform write then a width read, span after span, so one forced layout per span - and re-did it
  on every zoom step, on every page whose text had ever loaded. It now measures all spans of a
  page in one read pass and one write pass, one frame after the width changes, reading the target
  off the laid-out layer itself (a fit between the prop update and the font-size update made every
  span 24 % too wide); and only pages within THREE SCREENS of the reader carry a layer (a window of
  its own, wider than the one-screen render window).
- **What that window costs, honestly.** The browser's find-in-page (Ctrl+F) only searches text that
  is in the DOM, so a page read and then left more than three screens behind is no longer found
  until it scrolls back near; before, every page whose text had ever loaded stayed searchable.
  Likewise a drag selection can span about three screens of pages, not the whole document. The
  window is a trade between that and the zoom freeze: a layer on every visited page is what made
  each zoom step re-fit thousands of spans. The batched fit alone removed most of the freeze, so
  the window is wide rather than tight; an in-viewer search over `getPageText` would lift the
  find-in-page limit and is not built.
- **A copy kept no line ends** ("les**autres**", Mi 9T, 2026-10-12): the spans are absolutely
  placed, so nothing between them serialises as a break. Each run now carries pdf.js's `hasEOL`
  (an EMPTY item that ends a line gives it to the run before it: 3 of 230 items on page 40 of the
  scan) and the layer puts a `<br>` after it, as pdf.js's own viewer does. Read in the WebView: the
  same selection copies `les
autres` with the `<br>`, `lesautres` without.
- **And the layer was font-size times too wide, on every PDF.** `textRunBox` multiplied pdf.js's
  `item.width` by the run's scale, but pdf.js gives that width already in page units: a 43-character
  line measured 3.3 page widths. Selection and highlight boxes now match the glyphs
  (`pdfTextGeometry.test.ts` pins the real numbers).

Not done, deliberately: range requests or streaming. The source is a blob already decrypted in
memory, read whole in ~60 ms for 13 MB; the document opens in ~220 ms. **Owed:** one look on the
installed app, which needs a build carrying this change; the numbers above were taken on the same
WebView, renderer and phone, but not inside the signed-in app shell.

### The pinch, and why it needs a focal point

A pinch cannot rasterise every frame, so the gesture is previewed as a CSS `transform: scale()` and
SETTLED on release to the nearest of `ZOOM_STEPS`, which is what triggers the re-render. That much
was enough to make pinching *do* something, and it shipped that way on 2026-08-07.

It was not enough to make it usable. Reported from the device the same day: the zoom grew but "ca
augmente pas a l'endroit qu'on veut". The column scaled about `origin-top` and nothing touched the
scroll, so the paragraph under the fingers slid away exactly as the zoom took hold — on a phone,
where the pinch IS how you aim, that makes the feature worse than the buttons.

The correction has two halves that must share one focal point, or the preview visibly jumps as it
hands over to the real zoom:

- **During the gesture**, `transform-origin` is the pinch midpoint in the column's own coordinates.
  Scaling about a point leaves that point fixed, so the preview tracks the fingers. Both rects are
  measured at `touchstart`, while `pinchScale` is still 1 — reading them mid-gesture would fold the
  preview's own transform back into the origin.
- **On settle**, the column is re-laid out at the new width, and only THEN can the scroll be
  corrected. `anchorScroll` in [`utils/pinchZoom.ts`](../../../../frontend/src/lib/utils/pinchZoom.ts)
  puts the same content point back under the same finger. It runs after `await tick()`, because
  before the flush the column is still the old width.

**The correction anchors on the pinched PAGE, not on the zoom ratio, and that distinction is the
whole reason this needed a second pass.** A ratio-based correction — content sits at
`(scroll + focal) / from`, lands at `content * to`, so scroll becomes `content * to - focal` — is
what shipped first, and it is only exact if every pixel of the document scales together. It does
not: the scroll container's `py-3` and the column's `gap-3` are fixed CSS lengths. Measured on
device at x3, page 2 sits at `12 + 1677 + 12 = 1701` where the ratio believes `3 × 583 = 1749`, so
the correction overshot by **48 px** — and by one more gutter-pair for every page deeper in, ~192 px
by page 8. So the settle records WHICH page was pinched plus the fraction within it
(`anchorFraction`, `nearestBoxIndex` for a pinch that lands in a gutter), re-measures that page's
box after the relayout, and scrolls by the measured difference. That is exact whatever the
surrounding chrome does, including the `mx-auto` centring margin that the ratio also got wrong
horizontally.

Two consequences worth keeping:

- **The transform transition must be suppressed while the settle measures.** The column animates
  back to `scale(1)` over 120 ms and `getBoundingClientRect` reports the *animating* box, so a
  measurement taken mid-transition reads part of the gesture's own preview. `settling` gates it.
- **The zoom buttons are the same anchored zoom, about the viewport's CENTRE** (`pageAnchor`, then
  `anchorScroll`; one `zoomAbout` in the component serves both). Until 2026-10-12 they changed the
  zoom and left `scrollTop` alone, so every page grew under a scroll that did not move and the
  reader landed at page / zoom. Read with real taps on the Mi 9T (`pic86.pdf`, from page 40): before,
  x1.5 / x2 / x3 landed on pages 27 / 20 / 14; after, page 40 at every step and back down, the
  position within the page within 0.0005 of a page; sharp 0.6-0.9 s after the tap, longest task
  0.26-0.36 s. A real tap on the icon's SVG stroke itself produced no `click` in that WebView
  (`input tap`; pointerdown and pointerup arrive, no click), one on the button's padding did - the
  rig taps the padding.
- The module is deliberately pure and tested rather than inlined: it is the seed of the shared
  gesture WP-VIEWER-1 wants, and the arithmetic is the part worth pinning. MiGallery's `PhotoModal`
  can keep the ratio form because it scales ONE bitmap about its centre with no unscaled chrome
  between content and container; a PDF is a scrolling column of independently rasterised pages, so
  it needs both the anchor and the scroll model rather than a global translate.

`nearestStepIndex` breaks a tie towards the LOWER step, because overshooting into a more expensive
re-render on an ambiguous gesture is the worse outcome. `anchorScroll` and `anchorFraction` return
their input unchanged (respectively `null`) on an area-less or non-finite box rather than `NaN` — a
`NaN` assigned to `scrollLeft` is swallowed by the DOM, which would make the whole correction fail
invisibly.

### The two viewers share one shell, and two zoom models (WP-VIEWER-1, 2026-08-11)

Asked for on 2026-08-07: *"c'est presque la meme interface, ca meriterait d'etre joli, pratique et
homogene"*. The image lightbox and the PDF reader did the same job — take over the screen, name what
is shown, offer download and close — with two independent implementations of every part of it.

[`FullScreenViewer.svelte`](../../../../frontend/src/lib/components/shared/FullScreenViewer.svelte)
now owns the portal, the backdrop, the card, the header (`headerLead` / `headerActions` snippets plus
a close button it draws itself), the safe-area padding top and bottom, the focus trap and Escape.
[`MediaLightbox`](../../../../frontend/src/lib/components/shared/MediaLightbox.svelte) and
[`PdfViewerModal`](../../../../frontend/src/lib/components/shared/PdfViewerModal.svelte) bring only
what is theirs.

**The drift the merge exposed is the argument for having done it.** Neither copy looked wrong on its
own, and side by side they disagreed about things a reviewer cannot see from one file: one close
button carried a raw `aria-label="Fermer"` next to `m.common_close_label()` on the other (plus a
literal `"Suivant"` and `"Image {n}"` — three untranslated strings, now
`media_lightbox_next_aria` / `media_lightbox_dot_aria`), and one card said `z-[300]` where the other
said `z-300`. Two copies of a dialog do not stay identical; they stay *plausible*.

**What the shell deliberately does NOT own is the content area**, and the reason is the same
difference the pinch section above is about. A photo is one bitmap centred in a box that must never
scroll — so `MediaLightbox` passes `lockTouch`, which puts `touch-action: none` over the whole card.
A PDF is a scrolling column of re-rasterised pages, and that same `touch-action: none` would kill the
one-finger scroll that is *how a document is read*. Giving the shell a prop to decide which layout to
be would only move the knowledge of both viewers into the one component that was supposed to know
about neither, so `children` is rendered as the card's flex child and each viewer supplies its own.

The gesture is shared as arithmetic rather than as a component, for the same reason:
`clampTranslation` and `zoomAboutPivot` join `anchorScroll` and friends in
[`utils/pinchZoom.ts`](../../../../frontend/src/lib/utils/pinchZoom.ts), so the module now carries
**both** models — the global translate for a single bitmap, the anchor for a paged column — with the
warning that they are not interchangeable. The lightbox's DOM reads shrank to one `panBounds()`
helper; everything else is pure and tested (36 tests, 20 of them new). `zoomAboutPivot` *resets*
rather than clamps the translation at the minimum scale, which is not a detail: a clamp would leave
a photo wherever a gesture ended whenever the arithmetic happened to land inside the bounds, and
"unzoom puts it back" is the one thing a user is entitled to assume.

**Drag-to-pan now exists on the PDF, for a mouse only.** A finger already panned — the pages live in
a real scroll container with `touch-pan-x touch-pan-y` — but a mouse had nothing, and at x3 a page is
wider than the window, so following a line meant hunting for the horizontal scrollbar. It moves the
container's own `scrollLeft`/`scrollTop` rather than a transform, so it composes with the zoom
instead of competing with it. **It must not steal a text selection**, and `PdfTextLayer` makes that
test honest rather than heuristic: the layer is `pointer-events: none` with `auto` on the spans, so
a pointer-down whose target is a span is a selection and one anywhere else is a pan.

### The browser took the pan gesture first, on every image in the app (2026-09-22)

Reported from the app: *"on ne puisse pas (sur PC en tout cas) se deplacer dans la visionneuse (le
fait de tenter de drag l'image la selectionne)"*.

An `<img>` is `draggable` by DEFAULT. Press on one and move, and the browser starts a drag-and-drop
of the picture: it paints the translucent ghost the reader read as a selection, and it stops
delivering pointer moves. `handlePointerMove` never runs, so `panTo` never runs, so nothing moves.
Zooming worked (a wheel event is not a drag), which is what made it read as a broken viewer rather
than as a missing refusal.

`select-none` on the transform wrapper does NOT cover it. Measured in a live engine 2026-09-22: an
`<img>` inside a `user-select: none` container computes `user-select: none` and still fires an
uncancelled `dragstart`. Text selection and the native image drag are two different gestures, and
only one of them was being refused.

The refusal is `ondragstart` **on the transform wrapper**, not `draggable="false"` on the image. The
content is `{@render children}` and five call sites pass their own markup — `PostMedia`,
`PostContent`, `MessageMediaRenderer`, `ConversationMediaPanel`, `ChatComposer` — so an attribute
each of them has to remember is one of them eventually not remembering it. The wrapper already owns
the zoom, the pan and the dismiss drag; it owns their competitor too, for whatever is rendered
inside it. `MediaLightbox.nativeDrag.svelte.test.ts` pins both halves and fails when the handler is
removed.

### The photo viewer takes MiGallery's frame, gestures and information panel (2026-09-27)

Decided by the user on 2026-09-27: Canari's viewers take what MiGallery's viewer learnt copying
Google Photos, **with an information panel of simple facts**. `MediaLightbox` (all five call sites)
now works like this:

- **The frame.** `FullScreenViewer` gained an `immersive` frame: black edge to edge at every width,
  no card. The bars float over the picture on a flat `bg-black/45`, with no blur and no gradient. A
  single tap hides them (`chromeHidden`), and Back sits on the LEFT. The PDF reader keeps the card,
  because a column of pages needs its header in the flow, above the text.
- **The title** is the date on one line and the time on the next ("Hier / 11:42"), from
  `formatViewerDateTitle` in [`utils/mediaViewerInfo.ts`](../../../../frontend/src/lib/utils/mediaViewerInfo.ts).
  That function is ported from MiGallery with its tests. A photo still in the composer has no date,
  so it keeps its file name as the title.
- **The gestures:**
  - a horizontal swipe follows the finger and commits past 25 % of the width or on a flick;
  - a downward drag shrinks the picture and fades the black ground, so the page shows through, and
    closes past 20 % of the height;
  - a swipe up opens the panel;
  - a double tap toggles 2.5x.

  Which gesture a touch is, and whether a release commits, is decided in
  [`utils/viewerGestures.ts`](../../../../frontend/src/lib/utils/viewerGestures.ts). That module is
  MiGallery's, where every threshold is explained. It replaced `lightboxSwipeDismiss.ts` (a bare
  110 px threshold, with no flick and no shrink). **The zoom is still `pinchZoom.ts`**, for the
  reason given in the WP-VIEWER-1 section above.
- **A snap lands on the transform's own `transitionend`, never a timer.** A snap that would not move
  anything, or a reader who asked for reduced motion, runs its continuation at once: a transition
  that does not happen fires no end event.
- **The information panel** is a bottom sheet on a phone and a 320 px right-hand column from `md`
  up; the picture narrows beside it. It shows the date, the sender and the file (name, then size
  and dimensions).
  - The sender is a `UserName` for a message. For a post it is `postAuthorName`, now shared with
    `PostHeader` so the two can never disagree.
  - **The dimensions are MEASURED** on the element on screen (`load` / `loadedmetadata` in the
    capture phase), whatever the sender declared.
  - There is no camera and no place: the media is encrypted, and it is compressed before it is sent,
    which drops its EXIF.
  - Escape peels the panel, then the zoom, then the viewer. A swipe down closes the sheet before it
    closes the viewer.
- **`formatFileSize` now uses the locale's decimal separator.** The panel printed "2.3 Mo" beside
  "1,2 MP" on the same line; every size in the app now reads "2,3 Mo" in French.

Measured 2026-09-27 on a local preview, in Chrome with real `TouchEvent`s at 393 px (touch) and
1440 px:

- swipes to next and previous;
- the spring-back of a short slow drag;
- the refusal past the first item;
- tap / tap and double-tap / double-tap;
- swipe up opens the sheet;
- down closes the sheet, then the viewer;
- mid-drag: scale 0.91 and ground at 65 % at 150 px;
- Escape order, and the arrow keys.

**Owed on the Mi 9T**: the feel of the thresholds on a real finger.

### Rasterising is right; losing the TEXT was not (2026-08-11)

Reported from the app: "avec la visionneuse pdf on ne peut pas selectionner le texte, ni rechercher,
tout a ete transforme en image". Both halves of that are accurate, and the first clause is a correct
description of a decision that has to stay — a bitmap is the only renderer Android's WebView has (see
above). But **rasterising costs the text only if nothing puts it back**, and that is a gap rather
than a price: pdf.js's own viewer draws the same bitmap and lays the real characters over it,
transparent and positioned. That is what `PdfTextLayer.svelte` now does, fed by
`PdfDocument.getPageText`.

The layer has to survive the zoom, which re-rasterises the page underneath it, and that is what
decides its units:

- **Every box is a FRACTION of the page box, never a pixel** ([`utils/pdfTextGeometry.ts`](../../../../frontend/src/lib/utils/pdfTextGeometry.ts)).
  One extraction then serves every zoom step, every column width and every device pixel ratio, and
  nothing is recomputed when a page re-renders. A pixel layer would have been tied to one particular
  rasterisation and silently misaligned at the next.
- **Sizes are `em` against a `font-size` set to the page HEIGHT**, so the whole layer scales with the
  page by CSS alone — no measurement, no `ResizeObserver`, nothing to go stale between a relayout and
  the next frame.
- **The glyph height is `hypot(t[2], t[3])`, not `t[3]`**, and the run's advance `hypot(t[0], t[1])`:
  read off the matrix entries directly, a run rotated 90° collapses to zero height. Rotated text in a
  PDF is not exotic — a page-margin watermark is usually exactly that.
- **A run whose box cannot be computed is DROPPED, not placed at the origin.** A pile of spans in the
  top-left corner is selectable text that belongs nowhere, which is worse than text that is absent.
  Same reason `asMatrix` checks the length instead of casting: pdf.js types these transforms as plain
  `number[]`, and a five-entry array cast to a tuple yields an `undefined` that arithmetic turns into
  `NaN`, which CSS swallows.

Two things about the DOM side. `horizontalScale` stretches each span onto the width the PDF says the
run occupies, because the browser lays it out in a substituted font and the **selection highlight
follows the span**, so without the correction the highlight drifts further from the glyphs with every
word. And the layer is `pointer-events: none` with `auto` on the spans only: the gaps between runs
have to stay transparent to the pinch and scroll handlers above, or a text-heavy page becomes
impossible to drag.

`getPageText` is separate from `renderPage` rather than returned with it because the two have
different lifetimes — a page is re-rasterised on every zoom step and its text never changes — and
because it is the cheap half, no canvas and no PNG encode, which is what makes it affordable for
every page merely on screen.

**In-document SEARCH is not this**, and is not built: it needs the text of pages that have never been
on screen, a match model across runs (a word is routinely split over several), and scroll-to-match.
The extraction this adds is its prerequisite, not its implementation.

**What the device check must assert is the ANCHOR, never that the zoom changed.** The first run
here passed on "width% 100 → 300" against a build the user immediately reported as zooming in the
wrong place. `tools/cross-client-harness/check-pdf-anchor.mjs` identifies a content point (page
index + fraction) before the gesture and re-locates it after, and it was validated as a negative
control against the unfixed build first: drift (395, 1370) px there, (-17, -49) with the ratio
correction, and the anchor correction closes the rest — measured (-0.8, -0.5) on device.

## Autolinking bare domains, and why the TLD shape cannot decide it (WP-LINK-1)

`postMarkdown.ts` and `messageDisplay.ts` both turn bare hostnames in user text into links. A
heuristic that asks "does this token END in something TLD-shaped" is wrong in French: inclusive
writing and elided forms produce endings that collide with real TLDs - `.es`, `.it`, `.re` and `.ne`
against `auteur.rice`, `cher.e.s` and the like - and no amount of narrowing separates them, because
the two really are the same string. An exact WHITELIST of the hosts worth autolinking sidesteps the
ambiguity instead of trying to out-narrow it: a token is a link because it is on the list, not
because it looks like one. `postMarkdown.test.ts` and `messageDisplay.test.ts` pin both directions.

## A media that cannot be shown says why, typed at the throw (2026-10-01)

Every failure but a retention purge read "Impossible de charger le media" (user, Mi 9T): offline,
deleted and damaged were one sentence with nothing to do about it. The cause is now decided where
the failure is SEEN, as a type, and every renderer reads it through one classifier.

| Thrown by `mediaBlobCache` | When | `mediaFailureCause` | Retry offered |
| --- | --- | --- | --- |
| `MediaUnreachableError` | `fetch` itself rejected (offline, DNS, TLS, dropped) | `unreachable` | yes |
| `MediaPurgedError` | 410 | `expired` | no |
| `MediaNotFoundError` | 404 | `not-found` | no |
| `MediaDecryptError` | the bytes arrived, AES-GCM refused them | `corrupt` | yes |
| `MediaDownloadError` (`status` field) | any other non-2xx | `other` | yes |

- **Only the `fetch` is wrapped as unreachable**: a request dropped from `mediaRequestGate`'s queue
  rejects with its own `AbortError`, which every caller already ignores once it is torn down.
- **A ciphertext that fails to decrypt is evicted from the Cache API** before the error leaves, or
  the retry would re-read the same damaged bytes and fail identically.
- **`MediaLoadFailure.svelte`** draws the icon, the sentence and "Reessayer" (44 px, `stopPropagation`
  so it never also opens the viewer); the BOX stays the caller's. `mediaFailureLabel` writes the three
  new causes once and takes each surface's own wording for `expired` and `other`.
- **Retry is an `attempt` counter the download effect reads**: in place, no reload. Used by
  `PostMedia` (card and gallery viewer), `MessageBubble` -> `MessageMediaRenderer`, and the
  conversation media panel's viewer; `SharedMediaThumb` names the cause on its tooltip.
- **`logMediaFailure`** is the one log line: `console.error` for a retryable cause, `warn` for a 404
  or a purge, which are answers rather than failures. `MessageBubble` and `SharedMediaThumb`
  logged nothing before.
- **A defect it closed**: `MessageMediaRenderer` took `loadError` and `mediaPurgedByRetention`, a
  purge set only the second, and the image and video branches tested only the first - a purged photo
  pulsed as a loading skeleton for ever. One nullable cause replaced the pair.

**A streamed video fails with the same types (#1295's reader).** `httpRangeSource` throws
`MediaUnreachableError`, `MediaNotFoundError` and `MediaDownloadError` exactly as a whole download
does (an aborted read stays an `AbortError`), and a `SegmentedMediaError` reads as `corrupt` - a
tampered, reordered or truncated segment - EXCEPT the faults `encoding` and `version`, which a NEWER
client wrote: those are `other`, and their cached bytes are kept, since an update reads them.
`PostMedia`'s stream path classifies and logs through the same two functions as its download path.

## A video is Canari's to play: `VideoPlayer`, never `controls` (2026-10-01)

The viewers handed a clip to `<video controls>`, which is the ENGINE's bar: Android's grey strip
with its own "plein ecran" pill and download button on the Mi 9T, another one on iOS, neither themed
nor sized to a 44 px target. Two components now carry every video the app shows.

| Where | Component | What it is |
| --- | --- | --- |
| Feed card | `InlineVideo` | Instagram-style: muted autoplay while on screen, one sound button, a tap opens the viewer |
| Chat bubble | `InlineVideo manualPlay` | Discord-style: a play button, no autoplay (see below) |
| Single-media viewer, gallery viewer, chat viewer, conversation media panel | `VideoPlayer` | The full player |

- **A conversation's video plays when asked, not when scrolled to** (user, 2026-10-02, *"comme sur
  Discord"*): `InlineVideo`'s `manualPlay` mode. It shows its first frame with an amber **play
  button**; **the button starts the video where it is, with sound of its own**;
  **a tap on the rest of it opens the viewer, whose player starts it too**. No `playWhileVisible`, no
  loop (it stops on its last frame and offers play again).
  **A conversation has NO app-wide sound button, and its videos never touch `videoSound`** (user,
  2026-10-02: *"le bouton mute ne devrait pas apparaitre dans les conversations ... quand on appuie,
  TOUS les boutons de la page changent"* - the feed's rule, one answer for every video, is right for
  the feed and was wrong where each video is its own). The manual `InlineVideo` is audible from the
  start (`muted = false`), neither reads nor writes the app-wide answer - so a feed that autoplays
  muted cannot open a conversation video silent - and the chat viewer and the conversation media
  panel mount `VideoPlayer soundScope="local"`: it opens audible and its bar button mutes that one
  video (`followVideoSound(video, 'local')`). The feed, its viewer and the reel review keep the
  `app` scope exactly as before. Post comments render no video, and the replied-to preview and media
  thumbnails are muted stills, so no other surface carried the button.
  **ONE MEDIA PLAYS AT A TIME, IN THE WHOLE APP - this replaces the same-day "several can play at
  once"** (user, 2026-10-02, after #1341: *"commencer une video doit en arreter une autre ... pareil
  pour l'audio, les vocaux"*). ONE module, `actions/playbackArbiter.ts`: every `<video>` and `<audio>`
  that can make sound registers on mount (`use:arbitratePlayback`; `followVideoSound` for the viewer)
  and unregisters on destroy, and CLAIMS on its own `play` event, so a button, a native control and a
  programmatic `play()` claim alike. Every other media playing is PAUSED, not reset: it keeps its
  position, its own `pause` handler shows "play" again, no `ended`. Players: conversation video
  (`InlineVideo manualPlay`), voice note (`VoiceMessagePlayer`), audio attachment (`PostMedia`), feed
  video (`playWhileVisible`), the viewers (`VideoPlayer`, reels included). Not registered, so untouched:
  notification sounds, a call's streams, silent previews (`SharedMediaThumb`, `PickedMediaPreview`,
  the reel publish sheet's muted loop), the camera preview.
  Cases: **the feed's muted autoplay is AMBIENT** - it claims only against other ambient videos, a
  foreground media that starts pauses it, one scrolling into view does NOT start while a foreground
  media plays, and once nothing plays any more (`onPlaybackIdle`) the video on screen resumes, so the
  background never steals playback back; **a viewer opening** claims at once and, closing, hands the
  feed back (what the reader started inline stays paused); **a recorder** (`VoiceRecorder`,
  `reelRecorder`) calls `pausePlayback()` before it opens the microphone; **a refused `play()`** raises
  no `play` event, so it pauses nobody; **a page hidden** pauses nothing new (no `visibilitychange`
  listener). Calls are held off, so one starting is not wired - do it when they return. Tests:
  `playbackArbiter.test.ts` (video<->video, voice<->voice, video<->voice, feed<->conversation, viewer,
  recorder, refused play, unregister) and `VoiceMessagePlayer.svelte.test.ts`.
- **Opening a video full screen resumes where it is** (user, 2026-10-02: *"ouvrir une video en grand
  devrait reprendre la ou elle en est, pas au debut"*). The inline video and the viewer's player are
  two `<video>` elements, so the viewer started at 0. Several places open the viewer from an inline
  video (a chat bubble, a post, a post's gallery, a reel), so the position is not a prop threaded through
  each: `InlineVideo` writes `currentTime` to `utils/videoResume.ts` as the reader opens it, keyed by
  the media URL (both are handed the same decrypted blob URL), and `VideoPlayer` TAKES it when it
  mounts and seeks once on `loadedmetadata`, when there is a duration to seek in. **Taken, not read**:
  once the viewer has it, it is gone, so opening the same file later from somewhere that never played
  it (the conversation's media panel) starts at 0. **A clip that played to its end starts over** (a
  conversation's video does not loop; resuming on its last frame would end it at once). A streamed
  (MSE) `src` is minted per player, so it never matches and is not resumed. Verified in Chromium on a
  real clip: a chat video stopped at 2.6 s, the viewer opened at the same place and played on.
- **`VideoPlayer`'s bar**: play/pause, elapsed/duration, a seek bar (`role="slider"`, pointer
  capture so a finger leaving it keeps scrubbing) whose lighter fill is the range buffered under the
  playhead (`bufferedFraction`), the app's ONE sound answer (`followVideoSound`), and full screen only
  where `document.fullscreenEnabled` - a capability, not a fallback. Every target is `ui-icon-button`.
- **The bar fades** after `CONTROLS_FADE_MS` (2.5 s) of playback without a touch, and a paused
  video keeps it. **It comes back on ANY MOUSE MOVEMENT over the player, and a tap ANYWHERE on the
  player toggles it** (user, 2026-10-02) - anywhere means the black around a letterboxed clip too: the
  tap listener used to be on the `<video>` alone, which a phone's landscape clip fills a third of.
  Only a mouse's `pointermove` counts; a finger's is a drag (a swipe, a seek) and shows nothing. A
  key or a pause brings it back too.
- **Keyboard**: the player is one tab stop (`role="group"`); space/k, arrows (+-5 s), Home/End, m,
  f (`videoKeyAction`). It stops the arrows from reaching `MediaLightbox`'s previous/next.
- **Inside `MediaLightbox`** the bar carries `data-video-controls`, which the viewer's swipe, pinch
  and pan treat like a `<button>` (`NOT_A_GESTURE`): a drag on the seek bar is a seek. **The `<video>`
  itself is no longer on that list** (2026-10-02): its native controls were what put it there, and they
  are gone, so a pinch, a pan and a swipe that start on the picture are the viewer's.
  The player's root carries `data-video-player`: **a TAP that starts there is the player's** - the
  viewer neither cancels its click nor toggles its own title bar - while a swipe from there is still the
  viewer's. Before, a tap on the black margins was the viewer's, so the controls never answered on most
  of the screen. Verified in Chromium on a recorded portrait clip in the open viewer: the controls fade,
  a mouse move over the side margin brings them back, a touch tap on the margin toggles them both ways;
  `MediaLightbox.videoTap.svelte.test.ts` is red on the old viewer.
- **The controls are an overlay on a zoomable, movable picture** (user, 2026-10-02: *"les controles
  devraient etre une ui par dessus l'element video zoomable et deplacable"*). The player sits INSIDE the
  viewer's transform wrapper, so zooming the wrapper scaled the control bar and carried it off the
  screen with the picture. A first answer - never zoom a video - was dropped the same day. Now the
  viewer reads whether its frame holds a `[data-video-player]` (`hostsPlayer`, a `MutationObserver`:
  the content is `{@render children}` and a gallery swipes from a photo to a clip) and, if so, **the
  wrapper keeps only the swipe and the dismiss, and the zoom and pan go to the `<video>` alone**
  through the custom property `--lightbox-zoom`, which `VideoPlayer` applies to the element
  (`transform: var(--lightbox-zoom, none)`). The bar, the play button and the poster are siblings, so
  they stay put above the picture. A photo is unchanged (the wrapper carries everything).
  **Wheel and pinch zoom a video and a drag moves it; a CLICK or a DOUBLE-TAP does not start a zoom**
  (user, same day: a tap on a player toggles its controls) - a double-click still RESETS one. The
  `zoom-in` cursor is not offered over a video. **The click that ends a mouse pan is swallowed**
  (`panMoved`), or every drag would toggle the controls. Verified in Chromium on a real clip: five wheel
  ticks take the picture from 320 to 2560 px wide while the bar stays at 1000x84 in the same place, a
  drag moves the picture 80 px, the controls do not toggle, a double-click only resets.
  **Owed: a pinch and a one-finger pan on a phone** - the touch path is read from the code and tested
  for its taps, not exercised with fingers.
- **No native poster, ever.** `poster` stays `TRANSPARENT_VIDEO_POSTER` (the WebView's grey play
  button), and `VideoPoster` - Canari's ink-to-scrim gradient and an amber play disc - covers the box
  until `loadeddata` says the first frame is in the element. `InlineVideo` does the same, and the
  card's loading box IS that poster rather than a flat black one.
- **A streamed `src` reaches the element untouched.** `VideoPlayer` never appends to a URL, and
  `InlineVideo` keeps its `streamed` prop: `#t=0.1` only on a decrypted file, never on an MSE URL.
  A viewer opened while the card is still STREAMING has no `blobUrl` yet (an MSE URL feeds one
  element) and shows the poster until the last segment fills it.
- **A chat video is an `InlineVideo` now**, like the feed's, instead of a `<video controls>` in the
  bubble; the bubble's viewer is `VideoPlayer`.
- **Every video LOOPS, like Instagram's** (user, 2026-10-01): `InlineVideo` has `loop`, and
  `VideoPlayer`'s `loop` prop defaults to true. A looping element never fires `ended` and never
  pauses, so nothing in the bar can stick at the end: the time reads from 0 again on the next
  `timeupdate` and the fade keeps running. Both are pinned by tests.
- **A tap's FOCUS must not raise the controls** (Mi 9T, 2026-10-01): the player is focusable, a tap
  focuses it, and `focusin` ran before the `click` - so the controls came up on the focus and the
  click read them as up and hid them, and the first tap on a playing video did nothing visible.
  Chromium on the desktop never showed it, because the player was already focused. `focusin` now
  raises them only for keyboard focus (`:focus-visible`).

**THE SEAM CANAREELS (C7) BUILDS ON.** A reel plays in the feed and a touch opens a full-screen
vertical viewer that swipes to the next ([backlog](../../backlog.md)). `VideoPlayer` assumes no feed,
post or lightbox: it takes a `src` and the box classes, owns its bar, keyboard and fade, and reads
the app's one sound answer. The two things such a viewer brings itself are the gesture exclusion
(`data-video-controls` is the attribute to honour, as `MediaLightbox`'s `NOT_A_GESTURE` does) and
one-video-at-a-time, which `followVideoSound` already gives every element it is on. **Built
2026-10-02** ([reels](reels.md#watching-the-feed-card-and-the-full-screen-viewer-c7)), with one
correction to "one per reel": a mounted player CLAIMS playback, so the viewer mounts ONE, for the
reel on screen, and its neighbours draw the poster.

## Comment media (image + GIF)

A comment can carry one image or GIF (encrypted + uploaded via `MediaService.encryptAndUpload`,
stored as a `PostImageRef`). Three entry points, all funnelled through one `stageMediaFile` helper:
paste, the in-app GIF picker (`GifPickerModal`/KLIPY — fetches the chosen `.gif` bytes), and the
Android keyboard's GIF button (the `canari-keyboard-media` event; only the focused comment box
handles it). GIFs are uploaded as-is — never canvas-compressed, which would flatten the animation.

**The picker's path reads the bytes through Canari since 2026-10-18.** A picked GIF's bytes are
read (`fetchGifFile`, `gifMediaProxy.ts`) so they can be encrypted before upload — unlike a GIF in
**chat**, which is sent as its URL. They come through chat-delivery's GIF relay
(`/api/mls/gifs/media`), so KLIPY's CDN no longer sees the person attaching it
([chat](chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18)). Before that the
bytes were fetched from `static.klipy.com` directly, so `connect-src` had to list that host, and
listing only the search API (`api.klipy.com`) once blocked every picked GIF while leaving the grid
visible: the failure and the one-definition policy that replaced three copies are on
[cloudflare-edge](../../infrastructure/cloudflare-edge.md#the-origin-policy-is-stated-once-and-it-is-a-description-of-the-clients-code),
guarded by `frontend/src/lib/security/csp.test.ts` (the host stays listed for a tab on an older
bundle). The keyboard path is unaffected — it is handed the bytes directly.

**All three paths report their failure.** Each one ends in a toast (`post_comment_gif_fetch_error`
for the CDN fetch, `post_comment_media_error` for the encrypt/upload and the keyboard decode), and
the console line separates the causes the shared message cannot: a refused connection throws a
`TypeError`, a served error throws `HTTP <status>`. Before that, a failed attachment was a
`console.error` and nothing else, which is why a blocked host read as a dead button for weeks.

## Routes

| Route | Description |
|---|---|
| `/posts` | Main feed |
| `/post/[postId]` | Single post page |
| `/posts/new` | Create post form |
| `/notifications/requests` | The author's inbox of republication requests (D38b): accept or refuse an association's request to carry a personal post |

## One catch said seven things

A member reported on 2026-09-21 that a post would not publish from their phone. The app had told
them "Impossible de publier le post", and that was everything anyone had.

**The server could add nothing**, and settling that took two log reads: no `POST /api/posts` reached
nginx in the hour read, and `social-service` logged no error - so nothing server-side refused a post
in that window, and the trail was structurally empty.

**AND THE WINDOW IS THE LIMIT OF WHAT THAT PROVES.** Prod's containers restarted 2026-09-20 21:46
UTC, `docker logs` keeps nothing from before a restart, and the report did not carry a time. So the
hour read is the hour the report arrived in, not necessarily the hour the attempt was made in: the
reading rules out a server refusal DURING IT and says nothing whatever about an attempt outside it.
Stating it as "the request never left the device" is one step further than the evidence goes - the
same class of claim as one that names a mechanism without showing it gone. What is actually
established is narrower and still decides the work: **no post creation has ever been refused by this
server in any window anyone has read** - 7 days of prod logs hold exactly one `POST /api/posts`, a
`201`, and it was the rig's own.

A rights hypothesis was tested directly on 2026-09-21, because the first report came from an account
that could post when tried again as an admin. It is REFUTED: `posts.controller.ts` computes
`anonymous = !!body.anonymous && !body.associationId` and never consults `isGlobalAdmin`, the
composer offers "Anonyme" to everyone with no capability check, and a non-admin account driving the
real composer on the local prod copy published anonymously with a `201`. Neither half of the stack
gates it.

**AND IT WAS RE-RUN ON THE REPORTED SURFACE, WHICH IS THE HALF THAT MAKES IT EVIDENCE.** A browser
on a workstation is not what failed; an Android phone was. So the same drive was repeated on A1 -
`versionName=0.18.17`, the exact build of the report, a non-admin account, reversed onto a full copy
of production - and the row landed with `anonymous = t`. Identical on both surfaces.

So the class is NOT "anonymous posting is broken in 0.18.17", and no fix to the publish path is owed
or would have anywhere to go. What remains is one member, one attempt, and seven candidate stages -
which is exactly the shape the typed errors above were written for. **The composer now names its own
stage, so the next occurrence arrives with the answer attached instead of costing a day of log
reads that the retention window may no longer cover.**

`publishPost` can fail seven ways, and **five of them already carried a translated sentence at the
throw**:

| stage | cause | the sentence that existed |
| --- | --- | --- |
| `moderation` | the account is restricted | `post_action_not_allowed` (via the caller) |
| `content` | no text and no media | `post_create_content_required` |
| `mediaToken` | no upload token | `post_create_image_token_error` |
| `mediaUpload` | compression or upload threw | none - dev prose |
| `poll` | a poll with no question or under two options | `post_create_poll_requires_options` |
| `form` | the form attachment with nothing selected | `post_create_form_required` |
| `createPost` | the API refused | none - dev prose |

One `catch` replaced all five with the blanket line, and logged the cause at `Log.d` - debug - in a
file that already used `console.error` for a dropdown that would not load. **The one failure a
reader reports was the quietest line in it.**

The repair is the rule that governs every other seam here: **classify at the THROW, as a type**. The
five sentences are `LocalizedError`, which `utils/localizedError.ts` already existed for and which
`muteCheck.ts`'s own docblock had already named as the answer. Moderation is a `MutedError`, because
its message is dev prose and each screen picks its own line. `posts/publishFailure.ts` maps them,
and the composer records a `PublishStage` so the console names WHERE - a value, not a stack, because
the line has to be readable in an in-app log export from a phone.

**A transport failure is not a refusal, and one screen was saying it was.**
`PostCard.handleReaction` wraps `assertNotMuted()` - which ASKS the server - and showed
`post_action_not_allowed` for anything it threw. A reader whose radio dropped was told they are
restricted by moderation: not merely vague, but false and about them. That third call site is why
the mapping is a shared module rather than three inline ladders, and why its fallback is a required
parameter: "could not publish", "could not comment" and "action not allowed" are three screens and
no default is right on all three.

What deliberately keeps the fallback is a refusal from the write itself and anything the media
pipeline throws - English dev prose, for the console, and no distinction a reader can act on.

`publishFailure.test.ts` pins the mapping, including the two sentences that are ABOUT THE READER and
must not be said when they are not true.

### What the next report actually named, and the two defects under it (2026-09-23)

The reporter retried twice and **the edge log settled it without a phone, a database or the rig.**
`docker logs infrastructure-frontend-1` - nginx runs in the frontend container, there is no `nginx`
one - holds **four** `GET /api/moderation/me/mute-status` for the whole day, and `assertNotMuted`
has exactly three callers, so **every one of them is a write about to be attempted.** Two were
followed by a `201`. The other two are one device on `0.18.14` at 19:12:32 and 20:03:07 UTC, and
that device sent **no `POST /api/posts` all day.** Each is 15 s to 2 min after the composer mounted,
which its two loads make visible (`GET /api/forms` **and** `GET /api/associations/me/list`).

That collapses the seven stages to two without any client instrumentation at all:

| stage | how it died, from the wire alone |
| --- | --- |
| `moderation` | `200` and **51 bytes**, which is exactly `{"isMuted":false,"mutedReason":null,"mutedAt":null}` - the muted shape carries a date and is longer |
| `content` | unreachable: the Publier button is disabled on the identical predicate |
| `mediaToken` | `getToken()` is read per upload (it was a mount-time copy until 2026-10-05, which expired after 15 min and showed as a session error), so the branch is skipped |
| `mediaUpload` | no `/api/media` write from that device, and `compressImage` cannot throw - every failure it has is a typed passthrough, so an upload would have been attempted and logged |
| `createPost` | never sent |

**The reporter then named it himself: he was making a poll.** So the cause is `poll`, and the two
things wrong here were never the publish path - they are the two below.

**FIRST: THE COMPOSER PAID A ROUND TRIP TO LEARN A FACT IT HELD.** `publishPost` opened with
`await assertNotMuted()` and only afterwards checked content, poll and form - three preconditions
sitting in its own `$state`. That is the rule this repository states everywhere else: **never learn
by failing what a fact could have told you.** `posts/composerReadiness.ts` answers all three first,
and it is the ONE spelling of the button's rule (`hasContent`); the poll's own rules moved to
`posts/pollDraft.ts` with the editor rewrite below, so the payload builder stopped re-deriving the
option count a second time.

**SECOND, AND IT IS WHY THE REPORT CARRIED NO SENTENCE: THE ERROR BANNER ERASED ITSELF AFTER FIVE
SECONDS.** A timer decided when the reader had finished reading, and on a phone the keyboard can
still be covering the banner when it goes - leaving a composer that does not publish and says
nothing, which is the whole of what a member is then able to report. It is now cleared by the reader
(a dismiss button) or by the next attempt, never by a clock.

**AN ABANDONED TOGGLE NO LONGER COMES BACK (2026-10-01).** `includeForm` is still the one attachment
an account can be unable to satisfy - this reporter's `GET /api/forms` answered `[]`, and the card
then says so and offers "create a form" - but it used to be PERSISTED: both toggles were restored from
the draft, so a card opened and left empty returned silently at the next composer open and, for the
form on an account with none, refused every publish. `withoutAbandonedAttachments`
(`posts/postComposerDraft.ts`) keeps a toggle only when the reader put something in it - a poll with a
question or an option, a form with a choice - and `isPostComposerDraftWorthKeeping` is the ONE rule
for the auto-save and the restore alike, so a draft that held only empty toggles is neither saved nor
restored. Pinned by `postComposerDraft.test.ts`.

**THE DRAFT IS OWNED BY THE ACCOUNT (2026-10-06, iPhone reading of `alpha.4`).** `canari_post_composer_draft` was ONE value per device and never cleared on sign-out, so account B opening "Nouvelle publication" landed on "Brouillon restaure" holding account A's text. It is now `canari_post_composer_draft:<userId>` (`postComposerDraftKey`): a switch hides the other account's draft rather than erasing it, and the author finds it again - no sign-out hook, no timer. The two old unkeyed keys (`canari_post_composer_draft`, `canari_post_draft`) have no provable author, so every draft access DROPS them and logs `[POST_COMPOSER] dropping unowned ...`; they are never adopted. With nobody signed in the draft is neither read nor written. Same class, enumerated and left alone on purpose: `canari_recent_emojis` and the skin tone (a device preference, no authored text), `canari.keyboardHeight.v1` (a measurement of the device), `canari_post_new_form_id` and `canari_pending_contact` (`sessionStorage`, one tab, consumed on the next page). Pinned by `postComposerDraft.test.ts`.

## The blocks preflight erases

A reader reported on 0.18.17 that a post read nothing like what had been written: "the dashes do not
appear and the line breaks do not exist". **The markdown pipeline was measured and is not the
culprit** - `preprocessPostMarkdown` plus marked turn that post into exactly the `<p>`, `<ul><li>`
and `<hr>` the author meant, hard breaks included. Two lines of Tailwind preflight then erase it:

| preflight | what the reader loses |
| --- | --- |
| `ol, ul, menu { list-style: none }` | the dash typed in front of every item, and its indent |
| `*, ::before, ::after { margin: 0 }` | every gap between blocks - a list after a sentence, a rule after a list |

`[&_p+p]:mt-3` was the only gap anyone had ever restored, and it matches a paragraph after a
PARAGRAPH. Nothing else had one.

**`ProfileBioMarkdown` was correct by accident**, because it happened to spell `[&_ul]:list-disc
[&_ul]:pl-5` in its own class string - so the profile bio rendered a list while the post, the
most-read surface in the app, did not, and neither did a comment. That is the shape worth naming: a
rule written into one class attribute is a rule the other surfaces cannot inherit, and nothing tells
the author of the next renderer that it was ever needed.

The rules are now stated ONCE, on `.post-markdown` in `app.css`, and all three renderers
(`PostContent`, `PostComments`, `ProfileBioMarkdown`) wear it. What a component still owns is what
legitimately differs: heading sizes, font size, and the comment's `[&_p]:inline`.

`postMarkdownBlocks.test.ts` asserts the half a stylesheet cannot assert about itself. It sweeps
every `.svelte` under `src` for `<SvelteMarkdown`, requires the class on each, and refuses a
component that re-spells a block rule inline - so the fourth renderer cannot be born without it.
Verified red against the pre-fix comment renderer, green after.

An `hr` is the one case where preflight is not the whole story: it keeps `border-top-width: 1px`, so
the line was always visible. It was the zeroed margin that welded it to the sentences on both sides,
and `color: inherit` that made it as heavy as body text - hence `var(--cn-border)` rather than
`currentcolor`.

## One row per option, an identity on each, and a cap the server applies (2026-09-23)

The composer above named its stage; this is what the stage was ABOUT. The post surface asked for a
poll's options in ONE textarea, newline separated, labelled "Options (une par ligne)" - so the
structure of the data lived in the label. A reader who typed `Oui, Non` wrote one option and was
refused, and **the app already contained the answer**: `PollComposerModal`, the channel composer,
has had one input per option with a `+` and a bin since it was written.

`PollOptionsEditor.svelte` is now that editor, mounted by both surfaces, and `posts/pollDraft.ts`
holds the rules it is judged by. Two settings the server had always accepted arrive with it: a
CLOSING TIME, which `PostPolls` has been able to render and count down for as long as it has
existed and which nothing on a post could set, and a CAP on how many options one voter may pick.

### An option is an id and a label, and that is what a vote is cast against

The rows were `string[]` for about an hour of this work, with the editor holding a parallel array of
row ids so `{#each}` could key on something stable. That is two arrays that must stay the same
length, resynced by an `$effect` - and it made the real defect underneath impossible to fix:

**EDITING A POST EMPTIED ITS POLL.** `EditPostForm` sends the poll's id back under a comment reading
"preserved to maintain vote history". It preserved the id and nothing else. The tallies live in
`option.votes` and `votesByUser`; `updatePost` rebuilt each poll from the payload alone; `whitelist:
true` strips any tally a client tries to send back; and `PollOptionInputDto` had no `id` field, so
every save minted fresh option ids that could not have matched anything anyway. Correcting one word
of a question reset the poll to zero, with the id intact to suggest nothing had been lost.

So identity lives on the option (`PollDraftOption`), the DTO accepts it, and
`PostsService.normalizePolls` - ONE function, where the create and the update path each carried the
same map - carries votes across an edit BY OPTION ID. A renamed option keeps its votes, a deleted
one takes them with it, and `votesByUser` is DERIVED from what survived rather than copied beside
it, because two stored copies of one tally is how they come to disagree.

### Three places state the cap, and only one of them is not advisory

| where | what it decides | what happens if it is wrong |
| --- | --- | --- |
| `pollDraft.ts` | what may be COMPOSED | the author writes a poll that contradicts itself |
| `pollVote.ts` (`nextPollSelection`) | what may be SELECTED on the device | a tap does something the poll does not allow |
| `post-interactions.service.ts` | what may be RECORDED | anyone with `curl` decides |

`votePoll` enforced NOTHING until this day. `multipleChoice: false` was a rendering convention -
radio inputs send one id, so one id is what arrived - and a request that sent five recorded five
votes on a single-choice poll. A closed poll only ever had its buttons hidden. And an option id
belonging to no option of that poll cast no vote but WAS written into `votesByUser`, so it came back
to every reader as part of somebody's answer. All three are refusals now
(`post-interactions.vote-poll.spec.ts`), and the card stops offering a tap it knows will be refused
rather than learning by the 400.

### One selection array, several polls

`selectedOptions` on `PostCard` is flat across every poll on the card, which was invisible while a
post could only carry one: a tap on a single-choice poll replaced the whole array - clearing the
reader's answer to the poll beside it - and `submitVote` then sent that other poll's ids to THIS
poll's endpoint. `selectionIn(poll)` splits it once, on both sides of the write, which is also what
makes "two answers max" count the right answers.

## A deadline that arrives while the card is on screen (2026-09-24)

`PostPolls` takes `isOver` as a PROP and does not own a clock - the two callers' deadlines come
from different clocks and only the caller knows whose (COMM-15). What neither caller did was notice
the deadline ARRIVING. `PostCard` spelt it `new Date(poll.endsAt).getTime() <= Date.now()`, read
during render: `Date.now()` is not reactive, so the answer was true of the instant the card
happened to be drawn and nothing re-ran it. `ChannelPoll` read the server's `closed`, which is
stamped at hand-out and likewise never re-read. Either way the vote form stayed live after the poll
had ended, and the reader learnt by being refused with a 403 - **learning by failing what a fact
could have told us**, when `endsAt` was sitting in the payload the whole time.

Three pieces, and the split is what makes it testable:

| Piece | Where | What it is |
| --- | --- | --- |
| `pollDeadlinePassed(endsAt, at)` | `posts/pollVote.ts` | pure; the instant is a PARAMETER, never `Date.now()` |
| `msUntilPollDeadline(polls, at)` | `posts/pollVote.ts` | pure; the wait to the EARLIEST deadline still ahead, or `undefined` |
| `pollDeadlineClock(polls)` | `posts/pollDeadline.svelte.ts` | the rune wrapper: one `setTimeout`, cleaned up on unmount |

**ONE TIMER PER CARD, NOT ONE PER POLL**, because the feed scrolls and a card can carry several:
only the earliest deadline ahead is interesting, and when it lands the effect runs again and finds
the next. A card with no deadline schedules nothing at all, and an unparseable date yields
`undefined` rather than a `NaN` delay, which `setTimeout` would treat as zero and spin on.

**Whose clock, and which direction it may be wrong in.** The delay is computed from the deadline the
SERVER sent, against this browser's clock. That is safe here in a way the old comparison was not,
and the difference is not one of degree: a skewed comparison produced a permanent "still open", while
a skewed delay moves the closing moment by a few hundred milliseconds once. The flip is one-way - it
only ever adds closure - and the server stays the authority on whether a vote is taken.

Every instant in `pollVote.test.ts` is a literal, which is the campaign's standing rule for tests
and also the defect itself restated: the old code took its instant from a wall clock at render time.

## A poll option is free text, so it can only wrap (2026-09-23)

`PostPolls.svelte` is the ONE presentation for both surfaces that carry a poll: a post's poll card
and, through `ChannelPoll.svelte`, a community poll. Its option row carried `truncate` on the label,
which is `white-space: nowrap` - one line, ellipsis, whatever the text is.

That holds only if the label is short, and nothing makes it short. An option is free text typed by
the author (`PollSection`'s textarea, one row per option since later the same day), and the real
poll that surfaced this asked
which charity to give to: eight association names, seven of them longer than the box. Measured on
the component at a 360px-wide container, the label gets what the row leaves it - the 20px selection
icon, its 12px gap, then the percentage (`min-w-[2.5rem]`) and the count badge on the right - which
is under 200px. Every entry became `Confedera...`, `Gustave R...`, `Action con...`: the options were
not merely ugly, they were **indistinguishable from each other**, which is the one thing a ballot
may not be.

The label now wraps (`wrap-break-word`, `leading-snug`) and the row grows to two lines when it must;
`items-center` already kept the icon and the counters centred against a taller label. Verified by
mounting the component at 360px: eight labels, four of them on two lines, `scrollWidth` equal to
`clientWidth` on all eight - nothing clipped. The percentage moved from `text-text-main/60` to the
measured `--text-muted` token in the same pass, since a dimmed main colour was the darker of the two.

**The rule this leaves**: `truncate` is a promise that the container is authoritative and the text is
expendable. That is true of a filename in a chip or a voter name in a fixed-width tooltip; it is
never true of content the user wrote for other users to READ AND CHOOSE BETWEEN.

## "Share" confirmed inside a menu that had already closed (2026-09-27)

`PostActionsMenu`'s "Partager" row copied the post's public link, then flipped itself to a
checkmark and "Lien copié" for 2 seconds - a pattern copied from the forms list's inline share
button. But every row in this menu is wired through `pick()`, which sets `open = false` in the
same synchronous handler that runs the row's own action. The checkmark change and the menu's close
land in the SAME reactive flush, so the row only ever painted its confirmed state for the 150ms
`transition:slide` outro before the whole menu unmounted - not the 2 seconds the timeout intended.
User-reported: the row visibly flashed "Lien copié" (confirmed on `A1`, Chrome, web) but vanished
too fast to register as a confirmation - reported as "ça sert à rien" ("it's useless").

The fix moves the confirmation OUT of the menu: `sharePost` now shows a `showToast(...,'info')`
after the copy resolves, the same mechanism `chat_message_forwarded` and `common_download_saved`
already use, so it survives the menu closing. The in-menu `copiedLink` state and its `Check` icon
are dead code once the menu that hosted them closes before the timeout can matter, and are removed.

**The rule this leaves**: a confirmation that depends on the thing which triggered it staying
mounted is not a confirmation once that thing tears itself down as a matter of course - closing on
every pick, here. Feedback for a one-shot action needs a home independent of the control that fired
it. `copyPublicShareLink`'s rejection path was also a swallowed `void` with no log; it now logs
through `Log.d`, same as `copyId`'s own clipboard refusal.

## The "who reacted" list: a tap reacts, a hold shows who - Discord's gesture (2026-10-01)

**Decided by the user on 2026-10-01**, for messages and posts alike: *"appui simple pour reagir sur
une reaction existante, et maintenu pour voir qui a reagi"*, and *"la liste des gens ayant reagi doit
disparaitre des la prochaine action (scroll etc.)"*.

**What it replaced.** The 2026-09-30 version opened the list on HOVER for a mouse and on a 450 ms
hold for a finger. Hover meant a mouse opened the list on its way to every click, so reacting and
asking "who" were still the same gesture - *"on reagit et on regarde qui a reagi avec la meme action,
ca cree des problemes"*.

- **`actions/reactorsTrigger.ts` is the one gesture, for every pointer, a mouse included**: a tap
  toggles the reaction; a 450 ms hold (`LONG_PRESS_MS`, main button only for a mouse, cancelled past
  10 px of travel or when the pointer leaves) opens the list, and the click that ends the hold is
  swallowed in capture, so a hold never reacts. **A mouse hovers again since 2026-10-05** (user, on
  desktop): `HOVER_INTENT_MS` (400 ms) of resting opens the list, leaving or blurring closes it
  (`close` in the action's params), keyboard `:focus-visible` rests the same way, and the badge
  carries `aria-describedby` to the panel while it is open. What made the 2026-10-01 hover wrong - a
  list opened on the way to every click - is what the delay and the press (which cancels the rest)
  prevent; a touch never hovers and keeps the hold alone.
- **`ReactorsPanel` lives until the reader's next action.** One effect listens, in capture, for
  `pointerdown`, `scroll`, `wheel`, `keydown` and `resize` on the window, and any of them closes it -
  a press anywhere, the badge and the list included. The press that opened it is already down when
  it starts listening, so its own release does not close it. That one rule replaces four dismissals
  (a tap outside, `Escape`, a scroll, a mouse leaving after a 120 ms grace period).
- **In a conversation the reactions sit ON the bubble** (user, same day, pointing at Messenger:
  *"reaction apposee au message plutot qu'en dessous"*). `MessageReactions` pulls its row up over the
  bubble's bottom edge (`-mt-1.5`: 6px; the first 10px crowded the last line of text, so the user asked
  for it lower the same day), on the side the bubble is aligned to, and each chip is opaque
  with a ring in the thread's ground (`--chat-thread-ground`), which is what makes it read as laid on
  the bubble. The posts' badges stay in the action bar.

**Verified:** both suites (`ReactionsDisplay.placement`, `MessageReactions.reactors`) on the gesture
and every way out; in Chromium on a stand-in thread, light and dark: hovering opens nothing, a held
mouse opens the list, the release leaves it open, the wheel and a click elsewhere close it. **Owed:**
the hold under a finger on a phone.

## A double tap likes the post, and never unlikes it (2026-10-19)

**Asked by the user on 2026-10-19:** *"J'aimerais qu'on puisse liker un CanaReel en double cliquant
dessus (et qu'on puisse faire pareil pour tous les posts d'ailleurs)."* One Svelte action,
`actions/doubleTapLike.ts`, on every post card (`PostCard`, so the feed and `/posts/[id]` alike,
whatever the post carries) and on the reel on screen in the full-screen viewer (`ReelSlide`, see
[reels](reels.md#a-double-tap-on-a-reel-likes-it-2026-10-19)). A mouse double click is the same
gesture.

**What it does - Instagram's rule.**

- A post the reader has NOT reacted to gets "J'aime" (the heart, `DOUBLE_TAP_REACTION` in
  `posts/postReaction.ts`), through the reaction picker's OWN path: the card's `handleReaction`, so
  the tally moves on the tap, a mute already known refuses with the same line and sends nothing, the
  request goes behind `assertNotMuted`, and a failure rolls back with the same sentence. There is no
  second gate to keep in step: the button has none beyond the mute, and the server's refusal is
  answered the same way for both.
- A post the reader has ALREADY reacted to, with ANY reaction, gets the heart drawn again and NO
  request: a double tap never removes a reaction, and never replaces one the reader chose (a 😂 stays
  a 😂). The picker remains the one way to change or take back a reaction - and the keyboard's and
  the screen reader's way to like at all: the gesture adds no tab stop and no name, and a click with
  no pointer behind it (`detail === 0`: Enter, Space, an assistive activation) is never counted.
- A signed-out reader, or a card being edited, has no double tap.
- `DoubleTapHeart` draws the reaction's own picture (Noto's heart, `EmojiText`) where the second tap
  landed, springs it up and fades it (`.double-tap-heart` in `app.css`, 800 ms), and removes it on
  `animationend` - never a timer. Under reduced motion it is a still heart fading over 500 ms: the
  global reduced-motion rule would shorten it to 0.01 ms and remove it before a frame, so the class
  outranks it on purpose; an opacity change is not motion. One `navigator.vibrate(12)` through
  `utils/haptics.ts`, when the member has vibrations on - Android only, iOS WebKit has no vibration
  API and no plugin was added.

**How a double tap is told from a single one.** The taps are the engine's `click`s, read in the
CAPTURE phase on the card: a click is what the engine already decided was a tap (a press that
scrolled, panned or pinched makes none), and capture sees it before any child - `VideoPlayer` stops
its own click's propagation. Two clicks within `GESTURE.DOUBLE_TAP_MS` (250) and
`GESTURE.DOUBLE_TAP_SLOP_PX` (50) are a double, decided by `isDoubleTap` through
`createTapDisambiguator` - the arithmetic the media viewer's zoom and the message bubble's heart
already share, not a third copy. A third quick tap belongs to the same gesture (`quietAfterDouble`).
**The gap is measured between the events' `timeStamp`s - when each tap HAPPENED - never with a
clock read in the handler** (2026-10-22): on a busy phone the second click waits in the queue behind
the first one's handling and render, and a handler-time read counted that work into the 250 ms, so a
real double tap read as two singles. The message bubble had the same read (`Date.now()`) and takes
the same fix; the media viewer already used `timeStamp`. `doubleTapLike.test.ts` and
`MessageBubble.doubleTap.svelte.test.ts` queue the second click behind a 300 ms first handler.

- **On text, the header, a poll's question, a reel in the viewer: no single tap is held.** The first
  click goes on to its target at once. On text it does nothing; on a reel it toggles the player's
  controls, and the second toggles them back - the pair cancels itself, so nothing needs to wait.
- **On a media that OPENS A VIEWER the single tap IS held**, because no second tap can take back a
  full-screen viewer: a picture (`PostMedia`'s image button), a feed video and a reel card
  (`InlineVideo`'s open button), the gallery's "+N" cell carry `data-double-tap-defers`. Their click
  is stopped in capture and replayed (`element.click()`) once the window has passed with no second
  tap; a double spends it on the like. **That wait is `createTapDisambiguator`'s one timer and its
  stated reason: whether a second tap will come is not a fact any event carries before it comes.**
  If the value were wrong, a slow double tap would open the viewer, or a single tap would open it
  late - a feel, never a correctness or a traffic question. It is paid on those targets only.
  Enter or a screen reader opens them at once (`detail === 0`). A drag, a second finger or a
  `pointercancel` after the tap drops the held open, and an opener the feed removed meanwhile is not
  replayed. **Reasoned, not measured:** the replayed open now runs ~250 ms after the gesture; Chrome
  keeps a user activation for seconds, WebKit forwards one through a timer under 1 s, and the viewer
  starts its player after an asynchronous decrypt anyway - whether a reel still opens WITH SOUND
  for a member who turned it on is owed on the iPhone.
- **Never a tap of this gesture:** anything `tapBelongsToInnerControl` names (a link, a mention, a
  button, a poll option, a field, `role="button"`), anything under `[data-no-double-tap]` - the
  action bar and the comment section of the card - and the click ending a drag-selection of text
  (`hasActiveTextSelection`). A tap on any of these also ENDS a sequence, so text-option-text is no
  like.
- **The region is asked FIRST, before the media marker** (`classify` in the action). A comment's
  picture or GIF is a `PostMedia` button carrying `data-double-tap-defers`, inside the comments'
  `data-no-double-tap`; asked the other way round, a double tap on it liked the POST and its
  lightbox never opened (review of #2113). It now opens at once, with no hold, and never likes.
- **Link previews are OUTSIDE the gesture.** A `LinkPreviewCard` is an `<a>` around a `PostMedia`
  picture: a media opener nested inside another control belongs to that control, so the preview's
  picture opens at once as before and two taps on any part of a preview never like - the preview
  is another post's or another site's, not the one being liked.
- **A mouse double click does not select the word under it** on the card: its second `mousedown`
  (`detail === 2`) is prevented, outside controls. A drag still selects, and a long press on a phone
  still selects (it is never a click).
- **Every overlay a card opens is portalled out of it** (`FullScreenViewer`, `Modal`, the reel
  viewer), so a double tap inside a lightbox - its own zoom - never reaches the card.

**What `touch-action` was NOT changed, and why.** A double tap on a phone could also be the engine's
double-tap ZOOM. The feed and the post page scroll in `.page-scroll-wrap`, whose `touch-action:
pan-y pinch-zoom` (design-reference sections 28 and 38) already removes it - any value but `auto`
does - and the reel viewer's frame is `touch-none`. Whether WebKit honours that for a double tap on a
card is part of the owed reading. Adding `manipulation` to the card would intersect to the same
`pan-y pinch-zoom` and change nothing, so the #1223 tab-swipe rules are untouched: a double tap has no
travel, so it never engages the tab swipe, the reel viewer's swipe or the reply swipe.

**What it logs (2026-10-21).** One `[doubleTapLike]` line per decision and none per move or per
scroll: `press ended (<pointerType>)` for a press that stayed a tap, `click (detail N, <kind>)` for
each click, `sequence ended: <why>` when a sequence under way ends, `double tap` on the like. A WebView
nobody can inspect (TestFlight) thus shows whether the presses, the clicks, or neither reached the
card. It was added after DT-IOS: a native XCUITest double tap never liked on the iPhone 12 while real
W3C two-tap sequences did, so the detector was NOT changed - a pointer-driven detector waits for a
finger that reproduces two presses with no click after them.

**Pinned:** `doubleTapLike.test.ts` (window, slop, a third tap, a control's taps, a control between
two taps, no pointer, a second finger, a drag, a press inside the slop, a selection, a held media
tap opened once / spent on a double / dropped by a drag / not replayed once removed / dropped on
teardown, the word-selection guard), `PostCard.doubleTap.svelte.test.ts` (one request when not
reacted, none when liked or reacted otherwise, the heart's lifetime, a poll option and the action
bar keep their taps, the mute and failure lines, signed out, a viewer like reaching the card),
`postReaction.test.ts`, and on the reel side `ReelSlide.doubleTap` and `ReelViewer.like`. **Owed on
the Mi 9T and the iPhone 12:** [device-verification](../../device-verification.md#dt-a-double-tap-likes-a-post---owed-on-both-phones).

## Scheduled posts: where they show, and the event picker order (2026-10-06)

A scheduled post is visible to its AUTHOR only, in `ScheduledPostsPanel` above the feed of `/posts`
(`GET /api/posts/my-scheduled`); no feed shows it to anyone else until it is due
(`landingFeed.ts`). Each row now reads as "not final" in the agenda's own vocabulary: dimmed
(`opacity-50`) with a dashed ring from `pendingRingStyle()` (`calendar/feedEvents.ts`), the one
spelling shared with the agenda lists for proposed events ([calendar](calendar.md)). The "published
on <date>" line is the non-visual cue.

The "link to an event" picker (`linkableEventPickerOptions`, `utils/time.ts`, used by the composer
and the editor) lists the furthest future event first and the furthest past last; the server answers
ascending, so the sort lives in that one function.

**The strip leaves at the scheduled time (2026-10-08).** It used to stay stale until the tab was left
and re-entered (read on the Mi 9T, 2026-10-07: still listed a minute after the server published).
`/posts` arms ONE `setTimeout` on the earliest `scheduledAt` the strip holds
(`msUntilNextDue`, `posts/scheduledDue.ts`; nothing polls). When it fires the due posts leave the
strip (`stillScheduled`) and the feed is re-read so they appear where the server now publishes them;
the effect re-arms on the next one. A wait beyond the timer limit wakes early, finds nothing due and
re-arms. Server-clock skew is not corrected: a client a second fast re-reads the feed a second early.

## One notion of "when it became visible": `publishedAt` (2026-10-06)

Cause of the report "scheduled at noon for 18:00, published at 18:00 but shown as 12:00, behind newer
posts": nothing publishes a scheduled post (there is no flip job). Visibility is the predicate
`scheduledAt IS NULL OR scheduledAt <= NOW()`, while every feed query ordered by, and every card
displayed, `createdAt` - the moment the author pressed the button.

`posts."publishedAt"` (migration 077, NOT NULL) is `scheduledAt` for a scheduled post and the
creation time otherwise. `PostsService.createPost` and `updatePost` set it through
`publicationTime()` (`posts/publication-time.ts`), the only writer: rescheduling moves it, publishing
a pending post now sets it to now, un-scheduling an already-visible post keeps it. Feeds
(offset pagination, so no cursor), search, the promo cutoff, the announce sweeper order, the share
preview and republication cards read it; the client shows `post.publishedAt` (`PostHeader`,
`PostContent`, the `isNew` badge). `createdAt` keeps its meaning. Backfill is
`COALESCE(scheduledAt, createdAt)`, so an immediate post's order is unchanged. Reels cannot be
scheduled and keep `createdAt`. Notifications carry their own `createdAt` (written at announce time,
which is already publication time).

## A navigation never waits on data: the post page and the root layout (WP-NAV-1, 2026-10-10)

Audit in [offline-and-weak-network](../offline-and-weak-network.md) (section 13.2, on the upload PR): in this
SPA (`ssr = false`) a `load` that awaits holds the navigation, and two did. **`routes/posts/[postId]/+page.ts`
awaited the post**, so a tap on a post in the feed did nothing visible until the GET answered (up to the 20 s
read deadline on a weak link). It now returns the post as a PROMISE (`data.post`), the page resolves it in an
effect and draws the header, the back link and a skeleton (`role="status"`) at once; `undefined` = on its way,
`null` = absent or refused (the existing "not found" state). The title and path of the page's SEO are
static: the description used to be cut from the post's text, and this route is behind sign-in and never
server-rendered, so no crawler read it. The audience gate is still awaited, but only when no verdict is
remembered (the first ever visit): a remembered one answers from memory.

**`routes/+layout.ts` awaited `fetchUserProfile` on every navigation while the MLS session was not unlocked**
(boot, a resume, the whole unlock window): a profile round trip in front of every page, to decide one thing,
"redirect to login on a confirmed 404". It is now `checkSessionUserInBackground` (`utils/sessionProfileCheck.ts`),
launched beside the navigation: only a typed 404 redirects, a status or transport failure is survived and
logged, exactly as before. What stays awaited on purpose: `refresh()` when NO user id is known (the layout
cannot tell who this is, nor whether to send them to login). Pinned by `routes/navigationNeverWaits.test.ts`
(each `load` resolves while its network call is pending) and `sessionProfileCheck.test.ts`. Reaches users with
the next pre-release.

## Deleting a post asks first, through one path (2026-10-13)

`deletePostAfterConfirm` (`lib/posts/postDeletion.ts`) is the only way a MEMBER's control deletes a post
(the admin moderation queue, `routes/admin/moderation`, calls `deletePost` with its own moderation wording):
the post
menu's "Supprimer" (`PostCard`) and the scheduled-posts panel (`routes/posts`) both called the API on the
tap, so a slip of the finger destroyed a post while the reel editor and the review ask before discarding far
less (Mi 9T reading of `v1.2.4-alpha.2`). It asks with the app's `showConfirm` (`danger`, "Supprimer"),
returns `'declined'` without a request, and rejects on a failed request so each caller shows its own error
(the post card its error line, the scheduled panel a line under the strip).
Pinned by `postDeletion.test.ts`.

## The feed is drawn from the device first, then the server page merges over it (2026-10-15)

**The decision (user, 2026-10-15).** The feed is LOCAL-FIRST like the Communities tab (F1 and F4 of
[community-open-budget](../community-open-budget.md)). Offline, the feed used to say "Impossible de
charger les posts" for content the device had shown an hour earlier. The target: the feed draws in
under 0.2 s from a stored copy, even on a slow network or a weak phone, and the server's page then
merges over it.

### What is stored

- **The first page of each bare tab** (`associations`, `followed`, `all`, `custom`), as the server
  last answered it: the `FEED_FIRST_PAGE_SIZE` (20) rows of a first page, whether the route's first
  request or a refresh asked it (`posts/feedPageSize.ts`, the one copy). A refresh used to ask the
  scroll size (10), so a reconnect drew 10 cards and stored them for the next offline start (Mi 9T,
  v1.2.9-alpha.3). Later pages of
  the infinite scroll are not stored. A tab opened with `promo` or `formation` (a shared link) is
  not stored either, so the store holds at most four pages, bounded by construction rather than by
  an eviction rule.
- **In the account's own database, sealed under the device key**, like a salon's page (F4): a
  `feedPages` object store on IndexedDB, a `feed_pages` table on SQLite (`IStorage.saveFeedPage`,
  `getFeedPage`, `deleteFeedPages`). The payload repeats its owner, and a page naming another
  account is deleted, never drawn. `IStorage.clear()` empties it with the rest; a backup export does
  not carry it.
- **Without any of the reader's served rights.** Every `can*` field (`canManage`, `canPin`,
  `canReport`, `canUnmaskAnonymous`, `canRepublish`, `canProposeRepublication`,
  `canUnrepublishAs`, `canRequestRepublication`) is removed before the page is sealed, and so is
  `republicationRequests` (D38b: what the reader's associations asked an author, perhaps answered
  since); `canVote` is stored as `false`. A
  card drawn from the device therefore offers no edit, no delete, no pin, no vote and no
  republication until the server's own answer says who this reader is. A reader holding a nominative
  read grant (#1606) can never be offered a vote from the copy. The reason is the same as F1's for
  `viewerCanManage`: a copy would grant controls on the strength of a right the reader may have lost.

### When it is drawn

- **At mount, when this page instance holds nothing for the tab** (the in-memory `feedCache` of a tab
  switch still wins: it is younger), **and the server's answer has not arrived yet.** An answer that
  lands before the read finishes wins, and the read draws nothing.
- **Only while no unlock is pending for this account**: the session is up, or this account's unlock
  prompts nobody (`unlockUnattendedFor() === currentUserId()`, the F1 fact), and the session holds
  the device key for the account on screen. A device that owes a PIN or a fingerprint is locked, and
  nothing is drawn under the gate, before it, or after it is left for another page. The key itself
  enforces most of this: nothing sealed can be read before the PIN path has derived it.
- **The infinite scroll waits for the server.** While the stored copy is on screen, no next page is
  asked (an offset counted on a copy is an offset into a list nobody confirmed), and "Tout est
  charge" is not said.

### What the server's answer does to it

**THE SERVER PAGE IS AUTHORITATIVE FOR EVERYTHING IT COULD HAVE RETURNED, AND A FIRST PAGE COULD
HAVE RETURNED EVERY ROW OF THE COPY.** The copy is itself a first page, so the answer REPLACES every
row drawn from the device, wherever it sits, including when the answer is empty:

- a post deleted, hidden, moderated or unpublished since, and a post the reader can no longer read
  (an association left, an audience narrowed, a nominative grant revoked), disappears at the first
  answer that does not name it, on screen and in the store;
- a post pushed below the first page by newer ones is withdrawn too, exactly like F4's rows older
  than a full page: it comes back through the infinite scroll, from the server;
- reaction counts, poll tallies, comment counts and the pinned order are the answer's.

The store is then rewritten from that answer, so the next launch draws what the server last said.

**A card already drawn takes the answer's row (review of #1896).** The list is keyed by post id, so
the card drawn from the copy is KEPT when the answer replaces its row, and `PostCard` used to copy
its prop once: the vote stayed refused (`canVote: false`), the owner's and moderator's menu never
appeared, and counts, tallies and text stayed as stored for the whole session. The card now ADOPTS
a row whenever its prop is a different object (`PostCardLedger.adopt`, `lib/posts/postCardSync.ts`),
which happens only when the server hands a new row: the feed's own edits (a filter on delete, the
infinite scroll's append) keep each row's proxy. Adopting on identity rather than remounting keeps
an open comment thread and a half-typed comment.

**A ROW SAYS WHAT THE SERVER HELD WHEN ITS READ WAS ISSUED, NOT WHEN IT LANDED (second review).**
The first version kept a field only while a write on it was pending, so a feed GET sent before a
heart, landing after the heart's POST answered, erased the heart (and a vote's tally, while the
selection kept the choice). Both sides now sit on ONE order, a counter of the tab: a read takes
its point when it is ISSUED (`listPosts`, `searchPosts` and `getPost` stamp their rows through
`stampServed`, a non-enumerable symbol that `JSON`, `structuredClone` and a spread all drop, so a
stored or cached copy is unstamped, the oldest point); a write takes its point when it ANSWERS. A
row speaks for a field only when its read was issued after the field's last write answered and no
write on it is pending. No clock: the order is the program's own. EVERY write of the card goes
through the ledger: reactions, votes, new comments and comment likes (optimistic: `begin`/`end`),
and comment edit and delete, pin, unmask and a post edit (applied on the answer: `answered`). A
failed reaction or vote restores ONLY its field, and to the newest served value if a row was
adopted while it was out, not to the pre-tap one. A failed COMMENT write is narrower still: the
comment list carries several writes of the reader at once (a heart on one comment while another
comment is sending), so a failed comment removes only its own pending row and a failed heart puts
back only that comment (third review). A post edit's answer is taken for every field EXCEPT the
comments: an edit changes none, and its answer's list could collapse an expanded thread. **The expanded thread is HELD**: a feed row carries the first
comments only, so once the reader loaded the whole thread a feed row no longer replaces it, and a
new row asks for the thread again (`getPost`, merged through the same rule). The poll selection is
read from the card's polls, never from the prop, so it says what the tally says.

**A refused answer ends the copy.** A `401` or a `403` from the feed is an answer about this reader:
the copy leaves the screen (the existing no-audience or error state takes over) and every stored
page of the account is made unreadable. So does an audience verdict of `false`
(`revalidateFeedAudience`, `isOutsideFeedAudience`). The page's decisions are pure functions in
`feedStore.ts` so they are tested without rendering: `storedCopyMayDraw` (nothing is drawn once the
answer or a refusal is in, or while something is on screen), `firstPageFailure` (a refusal
withdraws and ends the copy, a transport failure keeps it unconfirmed), `feedMayLoadMore` (no
infinite scroll while the copy shows) and `feedRefetchOnReconnect` (see below).

**A failed refresh is not an answer.** A transport failure or a 5xx keeps the copy on screen,
marked unconfirmed: a line above the feed with a spinner says it is being refreshed, then that it
could not be refreshed, with a retry. It is logged once per tab load. The error screen is shown only
when there is nothing to draw, as before. Nothing signs out on a transport failure.

### How a sign-out and a change of account end it: an epoch, not an asynchronous delete

Every stored page carries an EPOCH, a random id kept per account in `localStorage`
(`canari_feed_store_epoch:v1:<userId>`). A page is drawn only when its epoch is the account's
current one. `clearUserLocally` (every sign-out, "Rester connecte" or not) and a change of account in
`saveUserLocally` erase every epoch SYNCHRONOUSLY, in the same call that erases the F1 community
list. From that instant nothing stored is drawable, whatever happens to the database afterwards.
The bytes themselves are deleted the next time the account's store is read or written: a read that
meets a dead epoch deletes every page, and the first write after a sign-in starts a new epoch and
deletes the old pages first. A write is refused when the device's sign-in record
(`canari_saved_user`) names another account or nobody, so a tab signed out elsewhere does not write
its feed back.

**The write decides its epoch BEFORE it awaits the storage** (`feedWriteEpoch`, synchronous), and
re-checks it after: a refusal or a sign-out that erases the epochs while the write waits on
`getStorage` used to let the write start a NEW epoch and seal a page drawable after the refusal.
Now the write finds its epoch gone and seals nothing.

**A page the read cannot open is deleted by that read.** `getFeedPage` rejects with a typed
`FeedPageUnreadableError` (another device key, damaged bytes) on both backends, and
`readStoredFeedPage` deletes every page of the store on it, logged at debug: a page left under an
old key costs one delete, not a warning on every launch.

**The main IndexedDB connection lets go of an upgrade.** A tab still running the previous bundle
holds a v9 connection; without an `onversionchange` handler the v10 open of a newer tab is BLOCKED
(`StorageOpenError(blocked)`). `IndexedDbStorage` now closes its connection on a version change
(logged), and reloads the page so that tab runs the new bundle rather than a closed store. A
`deleteDatabase` from another tab (`newVersion === null`) is left as before: reopening would
recreate a database being wiped.

**THE RELOAD DROPS WHAT THE OLD TAB HELD ONLY IN MEMORY, AND THAT IS DECIDED, NOT GUARDED (second
review of #1896).** It happens on the WEB only, and only when a newer bundle opens the same account's
database in another tab of the same browser: the phone and desktop apps have one WebView and use
SQLite. What the old tab loses is a chat composer's unsent text and a PIN prompt in progress; the
post composer's draft is in `localStorage` (`postComposerDraft.ts`) and the messages already handed
to the outbox are rows of this very database, so both survive. The two other
choices were worse. Keeping the connection blocks the NEW tab's open (`StorageOpenError(blocked)`)
until the old one is closed by hand, so the tab the reader just opened cannot start at all. Closing
without reloading (what `outboxBlob.ts` and `appLog.ts` do for their own small stores) leaves the
old bundle running against a closed store whose schema it does not know, so every later save fails
in it. A guard that waits for the tab to be hidden would keep exactly that broken tab on screen,
where the text it protects could not be sent anyway.

### Rejected options

- **`localStorage`, like F1's community list.** A synchronous read at module load is what made F1
  fast, but a feed page is the reader's whole first screen of posts (text, poll voters, comment
  bodies): kept in clear text, outside the database the device key seals, it would be the one copy
  of a reader's content readable without the key. The device key is in hand at the same instant the
  unlock gate opens (the vault path sets both together), so the sealed store costs one store read
  and one decryption, not a wait.
- **Deleting the pages at sign-out with an asynchronous `deleteFeedPages`.** It would open the
  account's database at the moment a revoked-device wipe may be closing and deleting it (an open
  handle blocks `indexedDB.deleteDatabase`), and a write still in flight could land after the
  delete. The epoch makes the sign-out a synchronous fact and leaves the physical delete to a
  moment when the store is known to be open for this account.
- **Merging the answer row by row (keep stored rows the answer did not mention).** That is what F4's
  first version did, and review found deleted messages coming back. A first page has no rows "the
  server could not have returned", so there is nothing to keep.
- **Keeping the served rights in the copy.** Rejected for the reason above: a revoked grant would
  keep its controls offline.
- **A freshness clock ("draw only if younger than N hours").** A clock says nothing about whether a
  post still exists or is still readable; only the server's answer does, and it replaces the copy
  whatever its age. An age limit would also empty the feed offline, exactly when it is needed.
- **Detecting a grant change on the device before drawing.** The device cannot learn that a grant
  was revoked elsewhere without asking the server. What the device does know (a refused answer, an
  audience verdict of `false`) ends the copy. What it cannot know is bounded by the first answer:
  until then the reader sees again what the server last served them, never anything new.

**A PIN change or a PIN recovery drops the stored pages** (`dropStoredFeedPages`, `pinChange.ts`)
instead of re-sealing them: they are a copy the next answer rewrites, and a page left under the old
key would fail to open on every later read.

### Measured (2026-10-15), and what is still owed

`tools/cold-start` is Android-only and the Mi 9T was taken by another measurement, so the DATA path
was measured on the desktop: a bench page (scratch, not committed) replaying exactly the read
`loadStoredFeed` makes - a fresh IndexedDB connection, one `get`, AES-256-GCM decryption, `JSON.parse`
and the rights strip - on a synthetic page shaped like a real one (a 600-character body, five
comments, thirty reactions, a media ref, a poll on every fourth post). Chrome on the workstation, 7 reads,
median (max):

| page | sealed size | CPU 1x | CPU 6x |
| --- | --- | --- | --- |
| 20 posts (what `load` stores) | 82 kB | 0.8 ms | 3.8 ms (4.2) |
| 60 posts | 245 kB | - | 7.2 ms (9.4) |

So the stored copy costs under 10 ms of the 200 ms budget even at 6x, and the rest is the first
mount of three cards (`progressiveCount`), which is unchanged by this work. **OWED ON THE PHONE**:
`tap -> Fil, first card` cold and warm, Wi-Fi and airplane, on the Mi 9T and on SQLite (whose read
goes over the Tauri bridge, which this bench does not cross), with the APK of this branch.

### The stored copy stayed on screen for the plugin's body read (2026-10-15)

**The reading.** Mi 9T, `v1.2.9-alpha.1`, online cold start: `<- 200 GET /api/posts` was logged, and
the "Fil enregistre sur l'appareil, mise a jour..." line still showed 3.1-3.5 s later, with nothing
in the console naming the wait. The `[API] <-` line is logged at the response HEAD; the copy leaves
the screen when `data.posts` resolves, which is after `res.json()`.

**The cause, measured** (CDP on the Mi 9T, the running app reloaded on `/posts` with an
instrumentation script installed before any app code: the `/api/posts` call, its head, the end of
its `json()`, the status line's frames and the long tasks; 3 runs each way, alternated):

| | head after the call | body (`json()` done) after the call | status line on screen |
| --- | --- | --- | --- |
| through the HTTP plugin (`v1.2.9-alpha.1`) | 246-779 ms | **4325-4605 ms** | 3.6-3.9 s |
| through the WebView's `fetch` | 189-256 ms | **214-276 ms** | never: the answer wins, first card at 650-736 ms from the server page |

At rest the same 52 kB body took 422-649 ms through the plugin and 3-13 ms through the WebView. The
main thread was idle for the last ~2 s of the plugin's wait (no long task), so nothing in the feed
was waiting: the body was. `plugin-http` reads a response body one `fetch_read_body` `invoke` per
chunk, queued behind every other `invoke` of a cold start (MLS, SQLite, the other API calls). The
feed's decisions (the epoch, the ledger, the adoption) cost nothing measurable here.

**The fix is the transport, not the feed**: a READ (`GET`/`HEAD`) to one of Canari's API origins goes
to the WebView's `fetch` (`shouldUseNativeFetch`, `utils/fetchRouting.ts`), like a binary upload
already did. Every service answers the preflight from the WebView origins, and social-service now
exposes `Content-Disposition`, the one non-safelisted response header a read consumes (the XLSX
exports). Writes with a JSON body, third-party hosts and the MLS delivery client
(`TauriMlsService`'s own plugin `fetch`) are unchanged. The design and the history of that rule are
in [mobile](../mobile.md#fetch-is-not-fetch-inside-the-webview); it is item F7 of
[community-open-budget](../community-open-budget.md).

**Back online, the feed asks again by itself.** After an offline start the copy said "pas de reponse
du serveur" 40 s after `[CONNECTIVITY] server reachable again`, until "Reessayer". The page now
subscribes to `connectivity.onReconnect` and runs the retry's own path (`refreshPosts`, whose rows
the cards adopt through `PostCardLedger`) when `feedRefetchOnReconnect` says so: the tab's last
request got NO answer (`firstPage === 'failed'`), no refresh is out, and the server is reachable -
the store also announces the browser's `online` event, which proves nothing, and announces again
once a request has reached the server, so one confirmed reconnect asks once. `refreshPosts` now
records its outcome in `firstPage`.

**A refresh answers for the tab it was issued for (review of #1922).** `refreshPosts` and the
infinite scroll read `data.feedParams` AFTER their await, so a refresh of one tab landing after a
switch was drawn over the next tab and written into its cache and stored page - a race the reconnect
made ordinary. Both now take the tab's params and a tab-load count BEFORE the await
(`refreshFirstPage` in `feedStore.ts`); an answer whose count is no longer current is dropped
(logged at debug), and the tab switch resets `loading`/`loadingMore`, which belonged to the old tab. The same reconnect reads the access token again when the launch
had none: offline, `getToken` failed and the cards' media (`authToken`) stayed hidden for the session.

**Noise of the offline cold start, the feed's share.** `[Posts] Failed to get token` (an error with a
raw `TypeError`) is now one `[POSTS]` line saying the media wait for the link, and an error only for
a failure that is not the transport. `[postNotifStore] load failed` warned on every minute's poll
while offline; a load with no answer is now said once per spell, and any other failure still warns
each time. Not the feed's and left to their owners: `[API] getToken failed ... proceeding without
auth` (`apiFetch`), the halving `[PENDING] page did not arrive ... retrying with limit=` (the MLS
pending fetch, `mlsDeliveryApi.ts`), `[DISPLAYNAME]`, `[A] refresh-transport`.

**Not verified:** the APK of this change on the Mi 9T (the "after" row is the same predicate injected
into `v1.2.9-alpha.1`), the reconnect refresh on a device, and the iPhone, whose WKWebView sends
`Origin: tauri://localhost` (already allowed, and the refresh POST already goes native there).

### What is unchanged

Reactions, votes and comments act on the server as before; no offline queue is added. Search is
not stored. The scheduled-posts strip is not stored. The in-memory tab cache (`feedCache.ts`) keeps
its role for a tab switch.

`lib/posts/feedStore.ts` (the sealed page, its owner, its epoch, the rights it drops, the gate),
`lib/posts/feedStoreEpoch.ts` (the synchronous erase) and `routes/posts/+page.svelte` (the draw and
the merge). Pinned by `feedStore.test.ts`, `db/feedPages.test.ts` (the v9 -> v10 upgrade with data
in place, and the version-change release), `postCardSync.test.ts` and
`components/posts/PostCard.served.svelte.test.ts` (the same id redrawn with rights opens the vote; a
row read before a reaction or a vote answered, or landing while it is out, does not erase it; a
failed reaction rolls back its field only, to the row adopted meanwhile). `feedStore.test.ts` calls
the real `saveStoredFeed` for the two write races.

## A post with two forms took the whole feed down: asked and answered are two records (2026-10-18)

**Production, client 1.2.9.** `/posts?feed=followed` showed the layout's error boundary
(*"Une erreur est survenue sur cette page."*) on `each_key_duplicate`. The feed list was not the
duplicate: its rows come from one `SELECT` over `posts` with a `LEFT JOIN` on the association's
primary key, which cannot return a post twice, and the reader's console held exactly one
`GET /api/posts`. The duplicate was INSIDE one card. A post carried two forms, and the console showed
each form's `GET /api/forms/<id>` and its `/check` issued TWICE, the crash landing right after the
last answer.

**The mechanism.** `PostCard`'s effect skipped a form only once its answer was IN `formInfos`, and
appended each answer to that array. The effect read the array it wrote, so the FIRST form's answer
re-ran it while the second was still in flight - the second was asked again and appended twice. A new
copy of the post handed to the card (the server's page replacing the painted one) did the same to
both. Two entries with one id reached `PostForms`' `{#each formInfos as fi (fi.id)}`.

**The fix** (`$lib/posts/attachedForms.svelte.ts`): whether a form has been ASKED is a record of its
own, non-reactive, so recording an ask re-runs nothing; the answers are held in a map KEYED BY FORM;
what is drawn is DERIVED from the post's own list of forms, so its order is the post's and it cannot
name a form twice. A post whose `forms` names one form twice is a server defect, logged as a warning
with the post id and drawn once. `attachedForms.svelte.test.ts` reproduces the interleaving with
hand-settled promises (the old algorithm drew `B, A, A`).

**One card can no longer take the feed with it.** Every card on `/posts` (feed and search) sits in its
own `<svelte:boundary>`: a card that throws is replaced by a one-line notice with a retry, and the
console line names the post - `[POSTS] card <id> failed to draw` - which the layout's line could not,
since a production Svelte error carries only its code. That boundary is a containment, not the fix;
the line it writes is an error and must be explained when it appears.

**Not changed, noted:** every feed arm orders by `pinned DESC, "publishedAt" DESC` with no unique
tie-breaker, so two posts sharing a `publishedAt` may swap across an `OFFSET` page boundary. The next
page's merge (`loadMorePosts`) already drops an id it holds, so this can skip a post, never duplicate
one.

## Comment sheet rework (2026-10-21)

Plan: a full-screen sheet from the comment icon, the composer pinned above the keyboard, replies folded, a draft per post, and posting as an association or anonymously. It ships in four pull requests; **this section records what is on `main`**.

**PR 1 - server paging and the client data layer (done).**

- `COMMENT_MAX_LENGTH = 2000` on `AddCommentDto.text` and `EditCommentDto.text` (`comment-page.ts` server side, `posts/api.ts` client side - a refused text is a 400).
- `editComment` writes `editedAt` (ISO, inside the comments JSONB, no migration); `PostComment.editedAt` carries it.
- `GET /api/posts/:postId/comments?cursor=<position>&limit=20&order=recent|oldest` serves WHOLE THREADS (`pageComments`): a head and all its descendants, never a split thread. The cursor is the array position of the last head returned, exclusive (`recent` walks down, `oldest` up). It is named `cursor`, not the plan's `before`, because one name has to serve both orders. Visibility is `assertVisible`'s and blocked accounts are dropped (a blocked head drops its thread). The "liked" order is applied by the client on what it has loaded.
- `commentCount` already counted replies and `PostCard` already read it through `commentCountOf` - the plan's "Charger tout hidden" item was stale.
- `postCommentDraft.ts`: one draft per account AND post, keyed like `postComposerDraft`.

**PR 2 - the identity of a comment (server; the client does not offer it yet).**

- `AddCommentDto` gains `associationId` (needs `POST_AS_ASSO`, `canPostAs`, else 403 BEFORE any write) and `anonymous` (any member). Exclusive, the association wins. The real `userId` is ALWAYS stored (mute, report, erasure act on the account); an anonymous or association comment stores NO name.
- `comment-identity.ts` is the one statement: `commentRights` (who may edit/delete, used to ENFORCE and to SERVE `canEdit`/`canDelete` per reader) and `serveComment` (withholds `userId` from everyone but the writer of an anonymous comment, a content moderator and a platform admin; an association comment's writer is not special; serves `association` card; `byPostAuthor` on a personal post only - the post author has NO privilege of revelation). Fields are only added: an older client keeps working on ordinary comments.
- Edit/delete: ordinary = writer (delete also a platform admin); anonymous = writer to edit, writer/admin/content moderator to delete; association = any `POST_AS_ASSO` holder or platform admin.
- Served in every path: feed windows and count (`serveRows`, BEFORE the post's own shaping since `byPostAuthor` reads `authorId`), `getById`, the paged route, and the like/edit/add responses.
- Notices are masked at the WRITE: anonymous -> actor `''` / "Anonyme", association -> its name. A reply to an association comment notifies every holder (`listFlagHolders`), to an anonymous one the real account.
- A report on a comment takes `reportedUserId` from the stored comment, never from the client.
- Account erasure keeps an association comment (writer detached, `userId: ''`).
- Privacy policy and register of processing say moderation can identify an anonymous author (dated 21/10/2026).

**PR 3 - the components.** `PostComments.svelte` (796 lines) is split; it stays the ONE section both hosts mount (the post card's sheet, and `ReelCommentsSheet`), so the rest of the work lands in two new files it renders:

- **`CommentItem.svelte`** - one comment and its replies. **Its controls are `canEdit` / `canDelete`, as the server served them**, never `userId === currentUserId` (an anonymous or association comment has no `userId` for most readers, `durable-rules` "a field the server strips for privacy cannot be the field a client derives a permission from"); the report shows where the reader cannot edit. Who wrote it is `posts/commentAuthor.ts` (`commentAuthorKind` / `Name` / `Href`: "Anonyme", "Anonyme - auteur du post" from `byPostAuthor`, an association's name and page, a profile link only when there is an account to link). "modifié" follows the time when `editedAt` is set. **A delete asks first** (`showConfirm`): a stray tap on the trash beside the pencil used to remove the comment and its replies. **Replies fold from two** ("Voir les N réponses"); one is shown directly, and a reply the reader just wrote (a pending id) or a notification opened the post at is never hidden. The small controls take `tap-target` (a 44 px hit box on a touch screen, drawing unchanged).
- **`CommentComposer.svelte`** - the box: several lines growing to about five (it was `singleLine`), `maxlength` = `COMMENT_MAX_LENGTH` and a counter near it, **Enter sends on a physical keyboard and is a new line on a touch one** (`isCoarsePointerDevice`, Shift+Enter always), **the caret goes to the box when "Répondre" is tapped** (`focus()`), the draft per account and post (`postCommentDraft.ts`, restored on mount - never over text already typed - and cleared when the box empties), one image or GIF (`stageMediaFile`, moved here unchanged), and **a failed send said beside the box** (`sendError`, `role="alert"`) instead of the card's bottom banner (`PostCard` and the reel sheet now route every thread failure to `commentError`).
- **The identity** is a small avatar with a chevron at the box's left: the member, "Anonyme", then the associations where the member holds `POST_AS_ASSO` (`listPostAsAssociations` now filters on that FLAG, not on "holds any permission" - the wider test offered associations the server refused; it fixes the post composer too). The list is asked once, when the box is first focused or pressed, not on mount (every card with a comment draws this composer, and a global admin's list is every association). `CommentIdentity` (`postIdentity.ts`) carries the association's CARD so the pending row is drawn under the right name before the server answers; `PostCommentThread.add(..., identity)` draws that row as anonymous (no account) or as the association and sends the matching fields. **The identity survives a FAILED send** (a retry never goes out under the writer's own name) and goes back to the member's own after a SENT one. A choice naming an association the list no longer holds is refused with a message, never sent as the member's own comment.

**What changed from the plan, and why.** The plan kept a failed row in the thread marked "Échec - Réessayer"; the shipped behaviour is the existing one (the row is removed, the text comes back, the error is beside the box, and sending again IS the retry), because a kept failed row crosses the card's ledger and its per-row rollback (`posts.md` "comment writes") for no gain a restored text does not give. **"Charger tout"** is now offered while the server's `commentCount` exceeds the rows held (it used to need 20 rows loaded) and reads "Voir les commentaires plus anciens"; real paging (`fetchComments`) is the sheet's, where the thread is its own and not a feed row's first twenty.

**The look (2026-10-21, after three prototypes compared on captures - the "A" direction).** The bubble is kept and made soft: no border, no shadow, no flat corner (`rounded-3xl`, the 18 px bubble tier), the avatar is 32 px, comments are spaced a little wider, and replies sit under their parent with no rule. **The like is ONE heart at the right end of the row under the bubble**, with its count beside it when there is one (accessible name "N J'aime", `aria-pressed`): there is no text "J'aime" button and no reaction chip on the bubble, so the count is said once (user: *"le symbole j'aime a un seul endroit, un coeur, en bas a droite mais sous la bulle, pas en mode reaction"*). The two other directions - a flat Instagram-style text with the name inline (-17 % height, but names mix into the text) and a flat hybrid with the time beside the name - were measured and not taken.

**The box is centred on its single line.** The editor, the GIF label, the send button and the identity avatar were each a different height, and the text sat 4 px low (measured: pill centre 570.6, text 574.6). They now share the send button's height - 44 px, or 38 px under `(min-width: 768px) and (pointer: fine)`, the `ui-icon-button` rule - through the editor's vertical padding (`py-3`, `py-2.25` on a mouse), a GIF label as tall as the button, and the avatar's bottom gap. Measured on a phone and with a forced fine pointer: every centre equals the pill's, and with three lines the buttons stay aligned on the last one.

**PR 4 - the sheet, and the thread read page by page.** The card no longer holds a conversation: it draws `CommentsPreview` (the newest top-level comment, "Afficher les N commentaires" when there are several, and a "write a comment" line - NOTHING for a post nobody commented on, which cost 90 px a card), and **every tap opens `PostCommentsSheet`**. The sheet is `Modal`'s `phoneFullScreen` (edge to edge on a phone, a dialog from `sm`): the title, a two-line reminder of the post, the thread scrolling in the height left, and **the box pinned under it** - `Modal`'s overlay already follows the space the keyboard leaves, so a body laid out as a scroll region plus a footer needs nothing computed (measured with the viewport cut to 480 px: the box's bottom edge at 466 px of 480, the list above it). The back gesture, Escape and the close button all close it.

- **The card hosts it, on its own write path.** `PostComments` (now only ever the thread's body: no inline mode, no show/hide, no preview slice) is given to the sheet as its content, so the ledger, the pending rows, the report dialog and the draft stay the card's. The sheet is mounted only while open, so the box takes its draft back on every opening, and what was typed survives closing it. The comment icon opens it with the caret in the box when the thread is empty, the "write" line always does, and "view the comments" opens it to READ (no keyboard over the thread).
- **A notification opens it at once.** `commentsOpen` now means "the sheet starts open", and the post page passes it only when `?comment=` named a comment (that reader came for the thread); anyone else who followed a link to the post sees the post, its newest comment and the write line - a full-screen sheet over what they came to read would be a decision made for them. The named comment is scrolled to and ringed inside the sheet.
- **Paging.** `PostCommentThread.loadMore()` reads the next page of `GET /posts/:id/comments` (20 whole threads, newest first) and ADDS it: **a row already held is never replaced by a page's copy** (a heart tapped while the page was in flight is newer), and **a comment removed meanwhile - here, or announced by another surface (`noteRemoved`) - stays gone** though the page was read before the deletion answered. `hasMore` is the server's answer and decides the "view older comments" button; before any page, the server's count against the rows held does. A failure is SAID (`post_comment_load_older_error`), never silent. When a fresher feed row replaces the card's, **the older pages already read are kept** (`keepHeld`: the row's own copy of a comment wins, nothing is read again) - the thread does not collapse to the newest few under the reader's thumb. The whole-thread read (`loadAll`, `GET /posts/:id`) and the ledger "hold" it needed are gone.
- **The sorts.** "Récents" is the order the pages come in; "Anciens" and "Aimés" are about the WHOLE thread, so they read the remaining pages first (up to 25) or "oldest" would be the oldest of what happens to be loaded; a page that brings nothing ends the wait.
- **Shared with the reel sheet.** `ReelCommentsSheet` mounts the same `PostComments` and the same `loadMore`; `CommentAuthorAvatar` is drawn by the thread and by the preview, so they cannot disagree about who wrote a comment.
- **The preview draws the comment's picture and its like (2026-10-31).** The collapsed preview used to render only the author and `text`, so a comment that was only a GIF (empty `text`, a `media` ref) showed as a name in an empty bubble; only the thread drew `media`. Both surfaces now share `CommentMedia` (`compact` is the preview's thumbnail) and `CommentLikeButton` (the heart, `aria-pressed`, the count, the `tap-target` 44 px box). The card hands the preview `thread.like`, the SAME write path as the sheet, so the two hearts read one comment and cannot drift (pinned in `PostCard.commentSync`); a pending row's heart is withheld, as in the thread. A like never opens the sheet (`openFromComment` ignores a `button`). A comment has one text and at most one picture; a mention is a markdown link and a reply is never the preview's comment, so there is no other kind to draw.
- **Fixed on the way.** The thread's list scrolled sideways: the 44 px hit box a small control gets (`tap-target`, the heart at the row's right end) stuck out of the scroller by a few pixels. The scroller now reaches the sheet's edges (`-mx-4 px-4`), so the box stays inside it.

**Seen** at 390 px in a headless Chrome on a fixture card (the preview, the open sheet, the viewport cut to 480 px). **NOT seen on a phone**: the real keyboard (iOS resizes the visual viewport, Android the layout one - the overlay is built for the first and the layout rule serves both, but only a phone settles it), the back gesture, and the focus handed back to the comment button on close.

## The edit picker always lists the attached form (2026-10-21)

`GET /api/forms` returns only the forms its reader owns or manages (`MANAGE_FORMS`), so an editor whose post carries a form they do not manage (a moderator, an officer without that right) saw "Aucun formulaire pour l'instant" under a post that visibly had one (user report, production). `EditPostForm` now passes the list through `withAttachedForm` (`$lib/posts/editableForms.ts`), which reads the attached form by id (`GET /api/forms/:id`, open to any signed-in reader) and puts it first when the list lacks it; a failed read is logged and the list stays as it was. Saving never depended on the picker: `attachedFormId` is written from the selected id, so the form was kept all along - only the display lied. Not changed: the create picker (a new post has no attached form) and who may attach a form they do not manage (the server still decides).

### The thread on a phone is the CanaReels drawer, with nothing quoted above it (user, 2026-10-23, phones only)

`PostCommentsSheet` picks by `phoneViewport()` (below `md`): the shared `shared/CommentsDrawer` - the very component `ReelCommentsSheet` is built on - rising over the interface on `motion-sheet-in` over a dimmed, tappable backdrop, closed by a drag down on its grabber/title, Back (one history entry), Escape, the X or a tap above. Over the page (`scrim`) it is portalled to the body, `aria-modal`, `focusTrap`ped, and the opener (read at initialisation, BEFORE `focusTrap` moves the focus) gets the focus back. It rides the keyboard (`keyboard-aware-bottom`, capped at `--app-viewport-height`) exactly as the reels sheet does. From `md` up the dialog (`Modal`) is unchanged. **The quoted-post reminder (avatar, author, two lines of text) under the title is REMOVED everywhere**, dialog included; the sheet no longer takes a `post` prop. Tests: `PostCard.drawer.svelte.test.ts` (phone) and `PostCard.sheet.svelte.test.ts` (wide). Only a phone confirms the entrance feel and the soft-keyboard behaviour.
