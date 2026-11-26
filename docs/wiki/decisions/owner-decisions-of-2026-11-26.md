## The owner's decisions of 2026-11-26

Recorded so no question answered here is asked again. They follow an inventory of every place a post
is displayed and every media viewer (`PostContent`, `MediaLightbox`, `ReelViewer`, the `VideoPlayer`
variants - [video-player](../frontend/modules/video-player.md)).

1. **Every post opens ONE viewer, CanaReels (`ReelViewer`), whatever media is tapped** (owner, 2026-11-26): a photo, a video or the "+N" cell. `MediaLightbox` stops being a post viewer. Built in `1.9.0`, [the entry](../backlog.d/p2-a-post-s-media-layout-one-to-many-pictures-and-videos.md).

2. **Full-screen video controls are the same everywhere** (owner, 2026-11-26): a thin scrubber that can be dragged, a tap plays or pauses, a long press pauses, and the time is shown while dragging. It applies to the conversation media viewer too; **the shell question stays as [video-player](../frontend/modules/video-player.md#the-owners-decisions-2026-11-09-final) argues** (the conversation viewer is not folded into the reel pager, which has a rail, likes and comments, where the conversation viewer zooms photos), so only the controls converge. Built in `1.9.0`.

3. **At the last media of a post, navigation stops at the edge** (owner, 2026-11-26): no wrap-around, a "3/9" counter and dots showing the position. Whether the dots are clickable or display only is decided when `1.9.0` starts; the recommended default is display only plus swipe, since a tap target that small is missed on a phone. Built in `1.9.0`.

4. **The small fixes ship in `1.8.3`, without waiting for the `1.9.0` unification** (owner, 2026-11-26): the post page shows the full text, the moderation preview opens CanaReels on that post alone, a comment picture's viewer is titled with the comment's date and author, a grid's viewer offers Download, one date per post (`publishedAt`), a post's audio plays through the voice-note player, and a doc comment is corrected. [Changelog](../../../changelog.d/post-display-polish.md).

5. **"Globalement, je veux une app homogene"** (owner, 2026-11-26, verbatim) - **a standing directive**: the same thing looks and behaves the same everywhere in the app - viewers, controls, dates, cards, headers, actions. Every duplicate path found in a review is a defect against it, not a style choice; it is the reason for decisions 1 to 3 and for the `1.9.0` unification entry. Charter principle 7, *simple* ([principes](../../principes.md)).
