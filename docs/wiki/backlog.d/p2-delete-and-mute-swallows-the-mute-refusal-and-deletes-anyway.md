## P2 - "Supprimer + muter" swallows the mute's refusal and deletes the post anyway

target: 1.7.1

**Found by:** the institution-moderator reading, sitting S6 on `1.7.0-alpha.12`, web, dev
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).
A test account holding `MODERATE` only in an institution hid that institution's post from the queue;
the "Posts masqués" tab then offered "Supprimer + muter" on it. That account may mute nobody: the
server answers a mute `403 MODERATION_OUTSIDE_OWN_INSTITUTION` (read with a direct call). The button's
handler (`src/routes/admin/moderation/+page.svelte`) runs `muteUser(post.authorId)` inside a bare
`catch {}` commented "already muted is fine", then deletes the post: the refusal is swallowed with no
log and no wording, and the moderator is told nothing while the author stays unmuted. The same holds
for a BDE moderator on a post whose author is outside its spaces. Not clicked during the reading (it
deletes). The handler is unchanged since `v1.6.12`, so not a regression; the institution door of
`1.7.0` is what puts it in front of a moderator who can never mute.

Seen on the same tab: its explanation reads "Ces posts ont été masqués automatiquement après avoir
atteint 5 signalements" above a post a moderator hid by hand, and the row names the author person,
not the institution it was published as (also seen in S4).

**The fix:** offer the control only where the server says the caller may mute that author - the rule
the queue has followed since 2026-11-02 ("the mute buttons are drawn from the server's answer alone",
`canMuteReporter` / `canMuteReportedUser`, `page.muteGating.svelte.test.ts`), which the hidden list
escaped, classify the
mute's refusal by its code with `describeModerationRefusal`, and stop before the delete when the mute
is refused. A component test: the button absent when the fact is false, and a refused mute neither
deletes nor stays silent.
