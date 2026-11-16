## P2 - editing a CanaReel's caption answers 400: the edit form sends the reel's own video back as `media`

target: 1.7.0

**Found:** 2026-11-16, Mi 9T, `1.7.0-alpha.2`, dev, an institution reel: the card menu "Modifier le post" opens the edit form, the caption is changed,
"Enregistrer" answers `PATCH /api/posts/:id` -> **400** and the form shows "Impossible de modifier le post".
Nothing is written. The server's answer is `a reel's caption is the only thing that can be edited (got media)`
(`assertReelEditShape`, `apps/social-service/src/posts/reel-rules.ts`; the rule is in
[reels](../services/reels.md): a payload naming `media` on a reel is a 400).

**Cause (read in the code, not yet fixed):** `EditPostForm.svelte` always builds
`payload = { markdown, media: allMedia, scheduledAt, attachedFormId, linkedCalendarEventId }` (the reach and the students-only switch ride along when changed) with
`allMedia = [...existingMedia, ...uploadedRefs]`, and a reel's existing media is its one video, so the body
carries a non-empty `media`. The server refuses it by design ("a silent drop would tell an editor it changed
the video"); the form was never taught that a reel's only editable field is the caption. Seen on the wire:
the body held the reel's `video.mp4` ref (`mediaId`, `iv`, `key`, `segmented-v1`) beside the new text.

**What a fix owes:** on a `kind === 'reel'` post the form sends the caption alone (and the reach, which the
server accepts, #3314), draws no attach toolbar (the form showed "Photo/video, Ouvrir la camera, Sondage,
Formulaire, Fichier, Programmer, 1/10 pieces jointes" on a reel), and a test of the payload for a reel. The
reading that closes it is the same edit on a phone: the caption saved, the card and the CanaReels viewer
showing it.

**How it was found, and a trap on the way:** the edit was the only way to make a caption just overflow on
the Mi; it failed, so the caption was written by SQL on the sitting's own fixture
([device-verification](../device-verification.md#the-mi-9t-readings-of-2026-11-16-second-sitting-170-alpha2)).
A second thing met on the same page: `fill` on the form's editor APPENDS to the text already there (the
contenteditable keeps its content), so a test must clear it first.
