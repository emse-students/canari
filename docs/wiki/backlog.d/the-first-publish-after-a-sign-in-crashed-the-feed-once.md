## P1 - The first publish after a sign-in crashed the feed page once (iPhone 12, 1.8.0-alpha.7)

target: 1.8.0

**What was seen.** On the iPhone 12 reading of `1.8.0-alpha.7`, the first post published after a
sign-in drew SvelteKit's "500" page, 40 ms after the publish queue took the post:
`[App] page crash on /posts: TypeError: null is not an object (evaluating '<9 chars>')`. Retry
restored the feed, the post existed, and four later publishes in the same session did not crash.
The composer had been opened through the header's `/posts?compose=1` link.

**What is known.** The crash is in the render flush that follows `onPostCreated`: the composer modal
closes, the form resets, and the feed reloads (`refreshPosts`, or `showFeed` when the post lands in
another tab than the one shown - the likely difference between the first publish and the later
ones). The live card's `GET /api/lives`, run by an effect of that same flush, never left: the page
failed before it. A happy-dom reproduction of both paths (the real page, the real `Modal` and
`CreatePostForm`) did not throw. The prime suspect is the Svelte `5.57.3 -> 5.59.1` / Kit
`3.2 -> 3.4` bump (#4028, first shipped in `alpha.7`), whose new order of actions and effects
already produced four null-lookup defects
([architecture](../frontend/architecture.md#svelte-559-runs-actions-and-effects-before-the-sibling-blocks-render-2026-11-24));
not proven.

**What was missing, and is now there.** The crash line named no module: the in-app log renders an
Error as its name and message only. Since this entry, `handleClientError` writes the first frames
of the stack (`describeCaughtError`), so the next occurrence names the chunk and column to map.

**Closing reading.** On the iPhone 12, sign in, set the remembered feed to "Pour toi", open the
composer from the header and publish a personal text post, three times across fresh sign-ins.
Either no crash, or a crash line WITH frames - which then names the fix.
