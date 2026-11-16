## Reading owed - editing a CanaReel's caption: the form sends the caption alone

target: 1.7.0

**Found:** 2026-11-16, Mi 9T, `1.7.0-alpha.2`, dev, an institution reel: "Modifier le post", caption changed, "Enregistrer" answered
`PATCH /api/posts/:id` -> **400** (`a reel's caption is the only thing that can be edited (got media)`,
`assertReelEditShape`, `apps/social-service/src/posts/reel-rules.ts`, [reels](../services/reels.md)). `EditPostForm` always
sent `media: [...existingMedia, ...uploads]`, and a reel's existing media is its one video.

**What is built (#3670):** on `isReel(post)` the form sends `{ markdown }` plus `studentsOnly` and `reach` when they change (both
are applied by the server before the reel rule), and never `media`, `polls`, `scheduledAt`, `attachedFormId` or
`linkedCalendarEventId`. It draws no attachment chips, no media strip and takes no dropped file (`PostComposerBar` `captionOnly`). The save is held
while the caption is blank, because the server's body rule refuses an empty `markdown` that names no media, and a reel edit may not name one: a
reel's caption cannot be emptied from the editor. Tests: `EditPostForm.reel.svelte.test.ts` (the payload of a reel and of an
ordinary post, the blank hold; they fail without the change).

**The reading that closes it:** on a phone, edit a reel's caption: the save answers 200, the card and the CanaReels viewer show the new text, no
attachment toolbar is drawn, and the save button is disabled once the caption is cleared.

**Not covered, on purpose:** a live replay (`kind = 'replay'`) is also caption-only on the server, but `isReel` is true of `'reel'` alone; whether a replay's pencil reaches this form is not verified here.
