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

## Routes

| Route | Description |
|---|---|
| `/posts` | Main feed |
| `/post/[postId]` | Single post page |
| `/posts/new` | Create post form |
