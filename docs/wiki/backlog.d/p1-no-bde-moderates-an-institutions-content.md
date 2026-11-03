## P1 - no BDE moderates an institution's content; only the platform admin does (owner, 2026-11-03)

**Decided, not built.** The owner, 2026-11-03: no BDE moderates an institution's content; only the
platform admin does. It is the content half of "Aucun BDE n'a les droits de gestion sur une
institution" ([association-permissions](../association-permissions.md#the-grant-ceiling-who-may-write-which-bits-2026-11-02)).

**Why it is open.** `AssociationsService.isContentModerator(userId)` answers "may this person
moderate content anywhere" - a platform admin, or a BDE member holding `MODERATE` (D23, moderation
stays global) - and takes no post. Its callers decide on a post, a comment or a live without asking
whose it is:

- `posts.controller.ts` `assertContentModerator` (hide, clear the anonymous flag, pin);
- `posts.service.ts` `assertMayManage` (edit, delete) and the `isModerator` of the request context;
- `posts/comment-identity.ts` `viewerFor` (comment controls);
- `lives/lives.controller.ts`, `lives/live-chat.controller.ts` (live moderation);
- `moderation/moderation.controller.ts` (reports, mutes, deleting a reported comment).

**What closes it.** One predicate taking the content's association: `isContentModeratorOf(userId,
associationId | null)`, false for a BDE moderator when that association is an institution, the
platform admin unchanged; every caller above passes the association of the content it judges, and a
real-SQL test proves a BDE `MODERATE` holder refused on an institution's post and admitted on a
club's. Reports and mutes name a person, not an institution's content, and stay global.
