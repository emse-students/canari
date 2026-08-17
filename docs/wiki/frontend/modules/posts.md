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

## Post creation (EditPostForm.svelte)

- Markdown content editor.
- Optional image upload (CEK not used here — public media via `POST /api/media/upload/public`).
- Optional poll (question + options).
- Optional embedded form (link to an association form).
- Optional scheduling (publish at a future time).
- Publish on behalf of an association (if admin with `MANAGE_ASSO`).

## Key components

| Component | Role |
|---|---|
| `posts/+page.svelte` | Feed page with tabs, search, infinite scroll |
| `posts/[postId]/+page.svelte` | Single post detail page |
| `EditPostForm.svelte` | Create/edit post (markdown, image, poll) |
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
