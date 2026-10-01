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

| Tab | Content |
|---|---|
| All | All posts from all associations |
| Followed | Posts from associations the user follows |
| Association filter | Posts from a specific association or category |

Posts are loaded via `GET /api/posts` (social-service), paginated with infinite scroll (`IntersectionObserver`).

## An anonymous poll stores a tally and no voters (2026-09-30)

A poll can be created **anonymous** (`PollInputDto.anonymous`), fixed at creation like a form's
(`normalizePolls` keeps the STORED value on an edit, so a request cannot flip it either way).
`apps/social-service/src/posts/anonymous-poll.ts` is the whole mechanism:

- **Stored**: `option.votes` is a NUMBER, and `poll.voters` is the list of accounts that voted, with
  no choice attached and **sorted**, so the list is not the order of arrival. `votesByUser` is `{}`.
- **Served**: `servePolls` drops `voters` and adds `voted` for THAT reader. It runs at the two
  points every served post goes through (`shapeListRow`, `toPublicPostFromEntity`) and on the vote
  response, so a participant list is never sent to anybody - not the author, not a moderator.
- **Final**: one vote, no change, no retraction. Changing a vote needs the previous choice, which is
  exactly what was not kept. The card therefore does not send an anonymous single-choice vote on the
  tap: it waits for the "Voter" button, as a multiple-choice poll does.

The price, stated: after a reload an anonymous voter sees THAT they voted and the results, but not
which option they picked - the server does not know.

## Post creation (EditPostForm.svelte)

- Markdown content editor.
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
  (Photo/vidéo, Appareil photo, Filmer, Sondage, Formulaire, Fichier, Programmer). Row two: "Aa",
  a status, and the action. **Markdown stays** (user) and "Aa" swaps row one for the formatting
  row: a pinned bar above the keyboard cannot afford a third row. The field is driven through
  `MarkdownComposerField.format()`, and the toolbar prevents `mousedown` so a tap keeps the caret
  and the keyboard.
- **Four file inputs, because the accept list chooses the chooser.** One input taking images,
  video, audio, PDF, Office and zip is what made Android open its generic file browser instead of
  the photo picker. Photos/videos, documents, and two `capture` inputs - which the app's WebView
  (wry, `RustWebChromeClient.onShowFileChooser`) turns into the system camera for `image/*` and the
  recorder for `video/*`. The two camera chips are not drawn for a fine pointer, where `capture`
  means nothing. **That needs a `<queries>` block in the Android manifest** for
  `IMAGE_CAPTURE` / `VIDEO_CAPTURE`: wry launches the intent only if `resolveActivity()` finds a
  camera, which API 30+ package visibility hides otherwise - and then it silently opens the photo
  picker (measured on the Mi 9T: `Tauri/FileChooser: Media capture intent could not be launched`).
  A photo also needs the app-specific `Pictures/` root in `res/xml/file_paths.xml`, where wry
  writes the capture - the second cause of the same symptom. `androidCaptureManifest.test.ts`
  guards both. **Every pick ADDS**: each input empties itself after handing its files over, so a
  PDF added after a photo no longer replaces the photo.
- **A picked video shows its first frame** (`PickedMediaPreview`, both forms). Every previewable
  pick used to go into an `<img>`, so a video - gallery or "Filmer" - drew a broken image, and an
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
  a video's `width`/`height` at upload (`readVideoDimensions`), so `PostContent` reserves the box
  at the clip's own shape; the video FILLS it (`object-cover`, cropped only by the
  `--media-max-height` ceiling - a clip's subject is in its middle, unlike a poster's text, and the
  whole frame is one tap away) and plays muted on its own (`InlineVideo`, rule in
  [durable-rules](../../durable-rules.md#ui-and-i18n---frontendarchitecture-auth-native-prompts)).
  The download lives in the viewer. A video posted before this carries no dimensions and keeps the
  4:3 box, filled the same way. Measured on the Mi 9T: a 1080 x 2340 clip in a 402 x 567 box,
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
(80svh, defined once in `app.css`) alongside the `aspect-ratio`. Past the ceiling the media is
CROPPED rather than shrunk. **The crop is CENTRED** (`object-cover object-center`): the ceiling was
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

The gallery lightbox holds `lightboxMedia`, which is the attachment list **compacted** to
image/video. A grid position is therefore not a lightbox index: each cell resolves its own index
via `indexOf`, and `-1` doubles as "not lightboxable". Passing the grid index would let one
document renumber every image after it.

## PDF previews, and the in-app reader

`utils/pdfDocument.ts` is the one pdf.js seam: it loads the library once, opens a decrypted
document, and rasterises any page to a PNG object URL. `PdfThumbnail.svelte` (page 1 only) and
`PdfViewerModal.svelte` (the whole document) both go through it. Two constraints fix this design:

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

Three things in `PdfViewerModal` are not obvious and each one produced a blank or flickering
viewer before it was right:

- **Its effects must depend on the document URL, and on the render width, and on nothing else.**
  Reading the page array inside either one makes every arriving page re-run the teardown, which
  revokes the object URLs the `<img>`s are currently displaying. Both read it under `untrack`.
- **A page already in view fires no new intersection event.** Lazy rendering is driven by an
  `IntersectionObserver`, so after a zoom invalidates every bitmap the observer has nothing to say
  and the viewer would stay empty — the visible indices are tracked separately and re-requested.
- **Zooming re-renders rather than scaling a bitmap**, so text stays sharp; the placeholder that
  stands in meanwhile keeps each page's own proportions once known (A4 until then), which is why
  `renderPage` returns the bitmap's dimensions rather than just its URL.
- **Pages are rasterised at exactly TWO scales, and the old bitmap is never taken off screen.**
  Both come from the same report: re-rendering per zoom step made a pinch through 1.5 and 2 on the
  way to 3 pay for every level, and each pass blanked the document — the placeholder replacing a
  page is an `aspect-ratio` box with `overflow-hidden`, so a page whose proportions were not yet
  known was visibly *cut* as well as emptied. `RENDER_ZOOMS` is therefore `[1, last step]`: the
  intermediate steps display a bitmap rasterised larger than they need, which the browser
  downscales and which costs nothing visually. A gesture now triggers at most one re-render, and
  1.5 → 2 → 3 triggers none. The current bitmap stays displayed throughout and is replaced in place
  when the sharp one lands — an old bitmap is the right image at the wrong resolution, which is
  strictly better than no image. Measured on device by
  `tools/cross-client-harness/check-pdf-render.mjs`, which samples the first page every 16 ms while
  the zoom ladder is walked: **473 blank-or-cut frames out of 475 before, 0 out of 474 after**, and
  the whole 1 → 1.5 → 2 → 3 walk now costs one rasterisation instead of four.
- **The re-render guard is the CSS width a page was rendered FOR, tracked separately in
  `renderedAt`.** It cannot be read back off the bitmap: `RenderedPdfPage.width` is the canvas size
  in DEVICE pixels (`maxWidth * devicePixelRatio`, capped), so comparing it against `renderWidth`
  compares two units and re-renders every page forever on any screen with a dpr above 1.

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
| Feed card, chat bubble | `InlineVideo` | Instagram-style: muted autoplay while on screen, one sound button, a tap opens the viewer |
| Single-media viewer, gallery viewer, chat viewer, conversation media panel | `VideoPlayer` | The full player |

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
the app's one sound answer. So a vertical viewer mounts one per reel, with `autoplay`/`loop` as it
chooses. The two things such a viewer brings itself are the gesture exclusion (`data-video-controls`
is the attribute to honour, as `MediaLightbox`'s `NOT_A_GESTURE` does) and one-video-at-a-time,
which `followVideoSound` already gives every element it is on.

## Comment media (image + GIF)

A comment can carry one image or GIF (encrypted + uploaded via `MediaService.encryptAndUpload`,
stored as a `PostImageRef`). Three entry points, all funnelled through one `stageMediaFile` helper:
paste, the in-app GIF picker (`GifPickerModal`/KLIPY — fetches the chosen `.gif` bytes), and the
Android keyboard's GIF button (the `canari-keyboard-media` event; only the focused comment box
handles it). GIFs are uploaded as-is — never canvas-compressed, which would flatten the animation.

**The picker's path crosses an origin, and the CSP has to name it.** A picked GIF is fetched from
KLIPY's CDN (`static.klipy.com`) so its bytes can be encrypted before upload — unlike a GIF in
**chat**, which is sent as its URL and never read by the client. So `connect-src` must list that
host, and listing only the search API (`api.klipy.com`) blocked every picked GIF while leaving the
grid visible: the failure and the one-definition policy that replaced three copies are on
[cloudflare-edge](../../infrastructure/cloudflare-edge.md#the-origin-policy-is-stated-once-and-it-is-a-description-of-the-clients-code),
guarded by `frontend/src/lib/security/csp.test.ts`. The keyboard path is unaffected — it is handed
the bytes directly, so a keyboard GIF worked throughout.

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
| `mediaToken` | `authToken` is taken at mount, so the branch is skipped |
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
  swallowed in capture, so a hold never reacts. Nothing opens on hover any more.
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
