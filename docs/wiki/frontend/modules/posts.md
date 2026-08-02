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

## Comment media (image + GIF)

A comment can carry one image or GIF (encrypted + uploaded via `MediaService.encryptAndUpload`,
stored as a `PostImageRef`). Three entry points, all funnelled through one `stageMediaFile` helper:
paste, the in-app GIF picker (`GifPickerModal`/KLIPY — fetches the chosen `.gif` bytes), and the
Android keyboard's GIF button (the `canari-keyboard-media` event; only the focused comment box
handles it). GIFs are uploaded as-is — never canvas-compressed, which would flatten the animation.

## Routes

| Route | Description |
|---|---|
| `/posts` | Main feed |
| `/post/[postId]` | Single post page |
| `/posts/new` | Create post form |
