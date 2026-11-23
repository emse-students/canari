# Moderation authority - who may do what to whom

**This page is the ONE copy of "who may do what to whom".** Every other page that touches moderation
([moderation-and-blocking](moderation-and-blocking.md), [profiles-and-access](profiles-and-access.md),
[lives](services/lives.md)) explains a MECHANISM and points here for the authority. A change of who may
act changes this page in the same pull request, and the grid's spec (below) with it.

Each grid gives the **TARGET** decided by the owner on 2026-11-15, and where today's code differs,
**what it does today**, with the work package that closes the gap. Citations name the file and the
symbol as read on `origin/main` at `02647463d` (2026-11-15); `SS/` is `apps/social-service/src/`,
`CS/` `apps/core-service/src/`, `CD/` `apps/chat-delivery-service/src/`. The code wins: a citation
that no longer matches is a defect of this page.

---

## The principle - "Chaque lieu se regule seul" (owner, 2026-11-15)

> *"tout doit pouvoir se gerer sans admin plateforme la plupart du temps"* - and *"avoir une grille
> claire de qui peut quoi sur qui"* (owner, 2026-11-15).

**Every place has a LOCAL regulator.** The association regulates its own thread, the BDE its spaces,
an institution its own content, a community's moderators that community. **The platform admin is the
last resort only**: an appeal, a case crossing spaces, a place with no regulator. **Every empty cell of
a grid below is a gap to close**, never a role the platform admin silently fills.

**Visibility rather than walls** (owner, 2026-11-15): *"Canari repose aussi sur les bons usages, et des
gens qui n'abusent pas de leurs permissions"*. A power is bounded by being SEEN - every act leaves a
trace its peers read ([the journal](#the-journal-and-the-notice)) - not by a wall a determined holder
could walk around anyway.

It follows principle **5 of the charter, "Une communaute, pas une audience"**
([principes](../principes.md)): Canari is made *with* those who make it live - students, alumni, the
School, the associations - so a place's own people regulate it, as they already run it.

Principle 1 bounds it: in the ENCRYPTED world (communities, salons, DMs, groups) no platform role and
no BDE has any route at all - the place's own members regulate it, on what they can decrypt.

## The decisions of 2026-11-15 (owner)

Quoted as given; the grids below apply them. 1 to 11 were taken first; 12 to 18 answered the
questions the first draft of this page left open, the same day.

1. **The principle above**, "Chaque lieu se regule seul".
2. **The moderation READ follows the post's own regulator.** A hidden post, its comments, a replay:
   a BDE moderator reads them within its scope, every read logged; the platform admin participates
   only as an ordinary reader. A replay is not a case apart (owner, 2026-11-15: *"La moderation des
   lives doit avoir le meme regulateur que les posts. Donc ouvrir."*, then *"Une rediff de live est un
   post/CanaReel comme les autres"*): its `?moderation=true` read asks the SAME predicate as the
   post's, `AssociationsService.mayReadToModeratePost`, and hands out the replay's key under it. One
   exclusion, the same everywhere (owner, 2026-11-15: *"Exclure les posts programmes"*): a BDE
   moderator does not read a post scheduled later until it is published, unless an OPEN report
   targets it; the platform admin's read is unchanged. Built by
   [PR #3561](https://github.com/emse-students/canari/pull/3561); the mechanism is in
   [moderation-and-blocking](moderation-and-blocking.md#the-moderation-read-of-a-post-its-comments-and-its-replay-owner-2026-11-15).
3. **An institution's `MODERATE` member does NOT moderate students.** The door and the scope count
   only governors of type `association` (`governorIsAnAssociationSql`); a space with no BDE stays with
   the platform admin. Built 2026-11-17 (`bdeModeratesUserSql` asks `governorIsAnAssociationSql`); [the reading](device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning).
4. **An institution's own `MODERATE` members moderate that institution's own content** - its posts,
   its lives, the comments under them - and the platform admin keeps recourse. Built 2026-11-17
   (`institutionModeratesOwnSql`, ORed into the publisher predicate `moderatesPublisherSql`; the door
   `MODERATES_SOMEWHERE_SQL`). A comment in the institution's name is its content wherever it sits; a
   club's comment under the institution's post stays the club's, as under a BDE's post (the lead's
   reading, reversible, the rule of 2026-11-03 applied both ways). A refusal to a caller who moderates
   only as an institution is its own code, `MODERATION_OUTSIDE_OWN_INSTITUTION`, never the BDE's
   "outside your spaces". The reader's institution standing comes from the membership read the
   comment pencil already makes (`AssociationsService.commentStandings`), so an ordinary reader pays
   no query for it. **Measured on production before the deploy (2026-11-17, read-only aggregate):
   0 institution memberships carry `MODERATE` (bit 128), of 4 institutions, and 0 spaces are
   governed by an institution** - so nobody gains or loses a power on deploy; the platform admin
   grants the first one.
5. **The author of a post, or the `POST_AS_ASSO` holders for an association's post, may HIDE (never
   delete) another person's comment under it**: a tombstone like moderation's, never revealing an
   anonymous writer. [WP](backlog.d/p2-a-post-owner-hides-a-comment-under-it.md).
6. **A reported community nickname goes to that community's moderators**, the platform admin as
   recourse; **a muted person cannot set nicknames**.
   [WP](backlog.d/p2-a-reported-community-nickname-reaches-the-community-moderators.md).
7. **An association's live is ended and moderated (chat lines, viewers) by its other `POST_AS_ASSO`
   holders**, not only by the broadcaster. [WP](backlog.d/p2-an-association-live-is-moderated-by-its-co-holders.md).
8. **Agenda: a BDE validates, rejects or deletes an event, but never rewrites another body's event
   text.** The same rule for **forms**, which the platform admin and the parent BDE's super-admin edit
   today. [WP](backlog.d/p2-a-bde-validates-an-event-but-never-rewrites-it.md).
9. **Sanctions: the mute extends to votes, comment likes and nicknames.** Community and group messages
   stay outside it - each place regulates itself. Account suspension touches MiConnect and is a
   [decided 2026-11-19: a platform admin suspends, in Canari only](backlog.d/a-platform-admin-suspends-an-account-in-canari.md).
   Votes and comment likes are built; nicknames: [WP](backlog.d/p2-a-reported-community-nickname-reaches-the-community-moderators.md).
10. **Encrypted groups (MLS): ALL MEMBERS ARE EQUAL.** *"A quoi sert un role d'admin dans les groupes ?
    Les communautes oui, les groupes, tout le monde est a egalite non ?"* The unread `role` column of
    `dm_group_members` and its misleading comment go; removing a member stays open to every member.
    [WP, a held migration](backlog.d/p3-the-unread-mls-group-role-column-is-dropped.md).
11. **The writer of an association's post is visible to its moderators** (the platform admin, the
    BDE in scope), as an association comment's already is; **the raw `authorId` of `/posts/hidden` is
    closed.** Built 2026-11-17: one rule serves it everywhere, `/posts/hidden` included (P8); the
    phone reading PASSED on `1.7.0-alpha.8` ([readings](device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)).
    **The lead's reading, reversible (2026-11-17): the writer is also served their own name**, drawn
    small under the association's like an anonymous post's author sees theirs - it tells them
    nothing they do not know, and one rule for both names is simpler than two. Reversing it is one
    line of `viewerSeesWriter` (or of the client's `revealedPostAuthor`). The association's OTHER
    holders are served no writer: nothing was decided for them.
    **No notification names the writer either** (review of #3770): a mention in an association's
    post names the association (`notifyPostMentions`, no member stored); an `association_post` or
    `association_repost` bell row keeps the member who acted - the actor exclusion and the review
    cohort read it - and the bell serves it blank; a post's mention STORED before the fix (the
    officer as actor, no association) is served as one written now - the association as actor,
    name and logo - when its post is an association's and its actor that post's author. Both are
    ONE shaping at the read, `withholdPublishingMember`: no row is rewritten, and every stored row
    is covered. A push shows the association's logo or no picture, never the member's face
    (`pushIconOf`). **A row naming nobody keeps the review cohort's rule of the person behind it**
    (review of #3770): the bell reads the cohort side of a row with an empty actor from the
    comment's writer, else the post's author (`bellRowActorAccountSql`, in `bellRowVisibleSql`) -
    the person its push was gated on - so a review account's anonymous or association-voiced
    mention is not pushed and then hidden. It costs a primary-key read per such row, and nothing
    while no cohort is configured.
    **Known, and bounded:** (a) a feed page is cached 30 s per reader (`post-list-cache`), so a
    moderator who loses the scope, or a writer whose post is edited away from them, can read the
    writer on a cached page for at most 30 s after; (b) the campus trend (`campus-trend.ts`) and a
    post's mentions (`mentionRecipientsOf`) skip a reader a block separates from the post's WRITER,
    an association's post included - so a reader who blocked, or was blocked by, the officer who
    wrote it may notice a trend or a mention that did not come. One bit, to the one person in that
    block, who cannot tell it from a post that simply did not trend; the read itself exempts an
    association's post from the author block, so the post stays visible.
12. **A parent BDE super-admin's rewrite: "Non, l'acte visible suffit".** Making oneself a member
    with the right to edit is a visible act, and good conduct is trusted: no further wall than
    decision 8's split. Decision 8's WP carries no open point any more.
13. **The moderation journal: "Oui, visible des pairs".** Asked whether every act - hide, delete,
    unmask, a moderation read, a mute - should leave a trace visible to *"les autres moderateurs du
    meme lieu (BDE, bureau, institution)"* and to the platform admin, the owner answered *"Oui,
    visible des pairs"*. Who counts as a peer for each kind of act is the lead's reading, reversible
    ([the journal table](#the-journal-and-the-notice)).
    [WP](backlog.d/p2-every-moderation-act-is-journaled-for-its-peers.md).
14. **The person whose content was hidden or deleted: "Savoir seulement".** They see WHICH PLACE
    acted (the association, the BDE, the institution or the platform admin), never the person, and
    the reason when one was given. There is no appeal inside the app.
    [WP](backlog.d/p2-a-moderated-person-is-told-which-place-acted.md).
15. **A comment hidden by the post's owner: "Auteur ou moderateur, en silence".** Asked who restores
    it and whether its writer is told, the owner answered: the post's owner or a moderator of the
    post restores it, in silence - the writer is told neither of the hide nor of the restore. This
    does not contradict decision 14: a hide by the post's owner is the place owner's lighter act, like
    a broadcaster hiding a line of their chat, not moderation, and decision 14 is about moderation.
    Decision 5's WP.
16. **A bio: "Effacement par l'admin et le BDE".** Erase only, never rewrite, by the platform admin and
    the BDE in scope; the person is told (decision 14) and the act is journaled (decision 13).
    [WP](backlog.d/p2-a-moderator-erases-a-bio.md).
17. **Auto-hide extends to comments**, with the same threshold; live chat lines stay with the
    broadcaster and the bureau (no auto-hide). That a moderator of the comment restores an auto-hidden
    one is the lead's reading, reversible (the post's rule).
    [WP](backlog.d/p2-auto-hide-extends-to-comments.md).
18. **A live chat line is hidden by the live's moderators (the BDE, the bureau, the platform admin)
    after the live ended**, as long as a report on it is open. Decision 7's WP.

"The bureau" is an association's (or institution's) `POST_AS_ASSO` holders - the **HO** column below.

---

## The roles

| Role | Short | What defines it in the code |
| --- | --- | --- |
| Platform admin | **AP** | the JWT's `admin` claim, forwarded by nginx as `x-global-admin: true` (`SS/common/guards/global-admin.guard.ts`, `GlobalAdminGuard`); granted by another admin only |
| BDE moderator | **BM** | `MODERATE` (bit 7) in an association of type `association` that governs a space (`isContentModerator`, `SS/associations/associations.service.ts`); every act then asks its SCOPE (`SS/spaces/bde-moderation.ts`): the content of the associations it is the parent of, and the people (and personal content) of every space it governs |
| Institution moderator | **IM** | `MODERATE` in an institution, governing a space or not: passes the door (`MODERATES_SOMEWHERE_SQL`, `SS/spaces/bde-moderation.ts`) and moderates the institution's own content only (`institutionModeratesOwnSql`, decision 4) - never a person, even of a space the institution governs (`bdeModeratesUserSql` asks `governorIsAnAssociationSql`, decision 3) |
| Holder ("the bureau") | **HO** | `POST_AS_ASSO` in the association, list or institution that published the thing: "the author" of every post and comment in its name (`isPublisherOf`, `SS/posts/posts.service.ts`) |
| Author | **AU** | the writer of a personal post, or of the item itself (a comment, a chat line) |
| Broadcaster | **BC** | a live's `broadcasterId` - a person, even for an association's live |
| BDE super-admin | **SA** | `MANAGE_ASSO` in the PARENT BDE: administers the association through `mayAct`, never `POST_AS_ASSO` nor the payout account (`SUPER_ADMIN_EXCLUDED_FLAGS`) |
| BDE agenda validator | **AV** | `VALIDATE_EVENTS` in the BDE of a space the event TARGETS (`holdsBdeAgendaRightOverSql`, `SS/spaces/bde.ts`) |
| Community admin / moderator | **CA / CM** | a community role holding `workspace.manage` / `channel.moderate` (`SS/channels/permissions.ts`) |
| Group member | **GM** | an admitted member of an MLS group or DM - all equal (decision 10) |
| Reader | **RD** | anyone who may open the thing; reports and blocks |

**Who regulates a public post, by its publisher** - the "local regulator" of decision 1:

| Publisher | Local regulator (target) | Today, where it differs |
| --- | --- | --- |
| a person (personal, anonymous, "Entre etudiants", a CanaReel, a replay) | the BM of any space the author belongs to (`bdeModeratesUserSql`) | - |
| an association or a list with a parent BDE | the parent BDE's BM (`bdeModeratesPublisherSql`, WP-D2) | - |
| a BDE | its own `MODERATE` members (`governingBdeJoinSql`: a BDE governs itself) | - |
| an institution | **its own IM**, AP as recourse | - |
| an association with no parent, a person with no space | AP - a place with no regulator | - |
| a student of a space whose governor is an institution, no BDE | AP - a place with no regulator | - |

---

## The grids

Cell legend: **yes** / **no** / **-** (does not apply). **A cell is a GAP if and only if it carries a
bracketed tag** (`[HIDE]`, ...): its text gives the target and `today: ...`, and the tag names
the work package that closes it. A tag is upper-case
letters or digits between square brackets that are not the text of a link (a link's text is followed
by its target in parentheses, a tag never is); no other cell of a grid holds one. `in scope` means the scope of the role, as
the table above defines it.

### Posts (association, list, institution, BDE, personal, anonymous, CanaReels, replays)

| Action | AP | BM | IM (own institution's post) | HO | AU (personal) | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Moderation read: a hidden or out-of-audience post, its comments, its replay - logged | yes (P1) | yes in scope (P1) | yes (P1) | no | no | no |
| Read one's own hidden post, CanaReel or replay, read-only (principle 1: it is theirs) - the lead's reading, reversible | no | no | no | **yes**, a post in its name (today: no, P1) [NOTICE] | **yes** (today: no, P1) [NOTICE] | no |
| Participate (react, comment, vote, report) outside the audience | no (P2) | no | no | no | - | no |
| Hide / unhide | yes | yes in scope (P3) | yes (P4) | no | no | no |
| Delete | yes | yes in scope (P5) | yes (P5) | yes | yes | no |
| Unmask an anonymous post (one-way) | yes | yes in scope (P6) | - | - | no | no |
| See the real author of an anonymous post | yes (P7) | yes in scope (P7) | - | - | yes, their own (P7) | no |
| See the writer of an association's post | yes (P8) | yes in scope (P8) | **yes**, its own institution's post, the lead's reading of 4 and 11 (P8) | no, the writer their own (P8) | - | no |
| Edit the text | no (P9) | no (P9) | no | yes | yes | no |
| Pin in a space (a promotion, not moderation) | yes | yes in its BDE's spaces, any publisher (P10) | no | no | no | no |
| Auto-hide | - | - | - | - | - | 5 pending reports hide it (P11) |

- (P1) `SS/posts/posts.service.ts` `moderatesPost` asks `AssociationsService.mayReadToModeratePost` and hands the answer to `readPostOpenVerdict` as `allowHidden`, logged `[MODERATION_READ]`; the hidden-posts list and a reported post's preview in the queue ask the same term (`bdeModerationReadsPostSql`). A BM does not read a post scheduled later unless it is published or an open report targets it (decision 2). Asserted in `SS/posts/post-openable.integration.spec.ts`.
- (P2) No write passes `allowHidden`: outside its audience a moderator, the AP included, is refused a reaction, a comment, a vote and a report like any reader (`SS/posts/post-openable.ts`; same spec).
- (P3) `assertModeratesPost` -> `mayModeratePost` (`SS/posts/posts.controller.ts`, hide/unhide/unmask routes).
- (P4) `moderatesPublisherSql` (`SS/spaces/bde-moderation.ts`): its BDE half is false for an institution (`governingBdeJoinSql`: `child.type <> 'institution'`), its institution half (`institutionModeratesOwnSql`) true for that institution's own `MODERATE` members; a BM refused on it gets `MODERATION_RESERVED_TO_PLATFORM_ADMIN`. Asserted in `SS/spaces/bde-moderation.integration.spec.ts` ("an institution's moderators").
- (P5) `assertMayManage` (`SS/posts/posts.service.ts`): AP, `isPublisherOf`, or `mayModeratePost`.
- (P6) `PATCH /posts/:postId/unmask`, behind `assertModeratesPost`.
- (P7) `viewerSeesWriter` (`SS/posts/posts.service.ts`), the one writer rule - see P8.
- (P8) `viewerSeesWriter` (`SS/posts/posts.service.ts`, decision 11): a post published under a name that is not its writer's - an association's or "Anonyme" - is served its `authorId` when the reader moderates it (`viewerModerates`: the AP, a BM whose spaces hold it, an IM on its own institution's post - `moderatedPostIds` reads `bdeModeratesContentSql`, whose institution half is asserted in `SS/spaces/bde-moderation.integration.spec.ts`) or wrote it, and to nobody else. `withholdWriterUnlessSeen` is the only place a served post loses its writer, and every read goes through it: the card (`toPublicPostFromEntity`), the feeds and the search (`shapeListRow`) and `/posts/hidden` (`getHiddenPosts`, which once returned the raw column). Asserted in `SS/posts/posts.service.can-manage.spec.ts` (by id and in `/posts/hidden`, seven readers, and the list's rows built through the shaping) and `SS/posts/post-openable.integration.spec.ts` (PostgreSQL, the real BDE scope). The client draws it as the anonymous reveal is drawn - the association big, the writer small under it with a pen (`revealedPostAuthor`, `RevealedAuthorLine`). The notifications follow it (decision 11): `notifyPostMentions`, `withholdPublishingMember`, `pushIconOf` (`SS/posts/post-notifications.service.ts`), asserted in `post-notifications.mention-gate.spec.ts`, `post-notifications.batch.spec.ts` and, for the bell's mention discriminator (`meta.mentionIn`), `SS/spaces/read-grants.integration.spec.ts`.
- (P9) `assertMayEdit` -> 403 `POST_EDIT_PUBLISHER_ONLY` (owner, 2026-11-02, [D23 amended](profiles-and-access.md#d23-amended---moderate-is-scoped-and-only-the-author-edits-a-post-2026-11-02)).
- (P10) `SS/posts/space-pins.ts` `bdePinsInSpaceSql`: `MODERATE` in the BDE OF THE SPACE (owner: pinning is not moderating), its governor of type `association` (`governorIsAnAssociationSql`, 2026-11-17): an institution governing a space with no BDE pins nothing there (decision 3), the platform admin does. Asserted in `SS/posts/space-pins.integration.spec.ts`.
- (P11) `SS/moderation/moderation.service.ts`, `createReport` - posts only.

### Comments (plain, anonymous, in an association's name)

"Place owner" is the post's AU for a personal post, its HO for an association's (decision 5).

| Action | AP | BM (post AND comment's publisher in scope) | IM (under its own post, or in its name) | Place owner | HO of the comment's association | AU of the comment | RD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Moderation read under a hidden post | yes (C1) | yes in scope (C1) | yes (C1) | no | no | no | no |
| See the real writer (anonymous, association) | yes (C2) | yes in scope (C2) | yes (C2) | no, never | no | yes, their own | no |
| Hide another's comment, silently (decisions 5, 15) | (delete covers it) | (delete covers it) | (delete covers it) | **yes** (today: no, C3) [HIDE] | - | - | no |
| Restore a comment the place owner hid, silently (decision 15) | **yes** (today: no hide exists) [HIDE] | **yes in scope** (today: the same) [HIDE] | **yes** (today: the same) [HIDE] | **yes** (today: the same) [HIDE] | - | no | no |
| Delete (a tombstone where a protected reply stays) | yes (C4) | yes in scope (C4) | yes, a person's under its post and its own anywhere, never a club's (C4) | no - hide only | yes | yes, with its thread (C5) | no |
| Edit the text | no (C6) | no (C6) | no | no | yes | yes | no |
| Delete from the reports queue | yes | yes in scope (C7) | yes (C7) | - | - | - | - |
| Auto-hide | - | - | - | - | - | - | **5 pending reports hide it**; a moderator restores it, the lead's reading (today: never, C8) [AUTOHIDE] |

- (C1) `SS/posts/posts.service.ts` `listComments` asks the post's own moderation read (`moderatesPost`, decision 2); the thread is served read-only where the moderator may not participate.
- (C2) `seesAccount` (`SS/posts/comment-identity.ts`); the post's author has no reveal right.
- (C3) `commentRights` (`SS/posts/comment-identity.ts`) knows only the comment's author and its moderators; no column and no route hide a comment.
- (C4) `commentRights.canDelete`, `bdeModeratesCommentSql`, `planCommentRemoval` (`SS/posts/comment-removal.ts`). The IM's comment in its institution's name, wherever it sits, is the second set of `bdeModeratesCommentSql` and `CommentViewer.moderatedInstitutionIds` in memory.
- (C5) `PostInteractionsService.deleteComment` (`SS/posts/post-interactions.service.ts`).
- (C6) 403 `COMMENT_EDIT_AUTHOR_ONLY` (`SS/spaces/bde-moderation.ts`).
- (C7) `mayModerateComment` (`SS/associations/associations.service.ts`).
- (C8) The auto-hide of `createReport` (`SS/moderation/moderation.service.ts`) counts posts only.

### Lives, their chat, cuts and replays

| Action | AP | BM | IM (own institution's live) | HO (association / institution live, not broadcasting) | BC | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Watch outside the audience | no (review cohort only, L1) | no | no | no | yes | no |
| Moderation read of a replay | yes (L7) | yes in scope (L7) | yes (L7) | no | no | no |
| Read one's own hidden replay, read-only (principle 1: it is theirs) - the lead's reading, reversible, as for a post | no | no | no | **yes**, a live in its name (today: no, L7) [NOTICE] | **yes** (today: no, L7) [NOTICE] | no |
| End the live | via a cut | via a cut | via a cut | **yes** (today: no, L2) [LIVE] | yes | no |
| Cut (ends it, records a strike) | yes | yes in scope (L3) | yes (L3) | no | - | no |
| Hide a chat line, live open | yes | yes in scope (L4) | yes (L4) | **yes** (today: no, L4) [LIVE] | yes | no |
| Hide a chat line after the live ended, while a report on it is open (decision 18) | **yes** (today: 410, L4) [LIVE] | **yes in scope** (today: 410) [LIVE] | **yes** (today: 410) [LIVE] | **yes** (today: no, L4) [LIVE] | no, the lead's reading (decision 18 does not name a personal live's broadcaster), reversible | no |
| Remove a viewer | no | no | no | **yes** (today: no, L5) [LIVE] | yes | no |
| Withdraw or restore the right to broadcast (a person) | yes | yes, a person of its spaces (L6) | no (L6) | no | no | no |
| Hide / delete a replay | as a post | as a post | as a post | delete | delete | no |
| Auto-hide a chat line | - | - | - | - | - | no: chat lines stay with the broadcaster and the bureau (decision 17) |

- (L1) `WATCH_ONLY = { adminSeesCohort: true }` (`SS/lives/lives.service.ts`).
- (L2) `POST /lives/:id/end`: `LivesService.end` checks the `broadcasterId`.
- (L3) `POST /lives/:id/cut`: `assertStaff`, then `mayModerateLive` (`bdeModeratesLiveSql`).
- (L4) `LiveChatService` hide: `own || isStaff`, refused 410 once `endedAt` is set, staff included.
- (L5) `POST /lives/:id/removed-viewers`: `LivesService.removeViewer` answers 404 to anyone but the broadcaster.
- (L6) `POST /lives/broadcasters/:userId/withdrawal`: `assertStaff`, then `mayModerateUser`.
- (L7) The replay read (`SS/lives/lives.service.ts` `replay`, `?moderation=true`) asks `mayReadToModeratePost` on the replay's post - the predicate of a post by id, decision 2 - past a removal, a block and the audience, logged `[LIVE_REPLAY] ... MODERATION READ`; without the flag, or for someone who does not moderate the post, the ordinary gate decides. Asserted in `SS/lives/lives.integration.spec.ts` (a BM in scope reads, one out of scope does not).

### Agenda events

| Action | AP | AV (targeted space) | SA (parent BDE) | Organiser (`PROPOSE_EVENT`) | Accepted co-organiser | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Validate / reject | yes (E1) | yes, an institution's event included (E1) | no, unless also AV | no | no | no |
| Edit the text or the date | **no**, the lead's reading of decision 8 (today: yes, E2) [AGENDA] | **no** (today: yes, E2) [AGENDA] | **no**, unless it makes itself a member with `PROPOSE_EVENT` - a visible act (decision 12) (today: yes through `mayAct`, E2) [AGENDA] | yes | text and poster only | no |
| Delete | yes | yes | yes | yes | no | no |
| Report | does not exist (E3) | - | - | - | - | - |

- (E1) `mayValidateEvent`, `holdsBdeAgendaRightOverSql` (`SS/spaces/bde.ts`): the agenda follows the spaces an event TARGETS, not the parent (owner, 2026-11-03).
- (E2) `assertMayWriteEvent` (`SS/associations/associations.service.ts`): a global admin, `mayValidateEvent`, or `mayAct(PROPOSE_EVENT)` - which a parent super-admin passes. The same gate guards `PATCH` and `DELETE /associations/:id/events/:eventId`. Decision 8 names the BDE; refusing the AP's rewrite too is the lead's reading (the platform admin edits no other text, P9 and C6), reversible.
- (E3) `REPORT_CONTENT_TYPES` names no event.

### Forms and polls

| Action | AP | SA (parent BDE) | `MANAGE_FORMS` holder | Personal form's owner | BM | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Edit an association form's questions or text | **no** (today: yes, F1) [AGENDA] | **no**, unless it makes itself a member with `MANAGE_FORMS` - a visible act (decision 12) (today: yes, F1) [AGENDA] | yes | - | no | no |
| Close or delete an association form | yes (recourse) | yes | yes | - | no | no |
| Edit a personal form | **no** (today: yes, F1) [AGENDA] | - | - | yes | no | no |
| Delete a personal form | yes (recourse) | - | - | yes | no | no |
| Report a form | does not exist | - | - | - | - | - |
| A post's poll | follows its post | - | - | - | follows its post | - |
| Close a salon poll | no | no | - | its author | no | CM: yes (F2) |

- (F1) `managesForm` (`SS/forms/form-ownership.ts`): a global admin; `MANAGE_FORMS` through `mayAct`, which a parent super-admin passes (`MANAGE_FORMS` is not in `SUPER_ADMIN_EXCLUDED_FLAGS`); a personal form's owner.
- (F2) `SS/channels/channel.service.ts`, the salon poll close.

### People: profile, mute, community nicknames

| Action | AP | BM | IM | CM (of the community) | The person | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Edit name, campus, cursus, roles (identity provider fields) | yes (U1) | no | no | no | asks a correction | no |
| Erase a bio (never rewrite it; the person is told, the act journaled) | **yes** (today: no, U2) [BIO] | **yes, a person of its spaces** (today: no, U2) [BIO] | no | no | writes their own | no |
| Report a person | - | - | - | - | - | yes |
| Mute / unmute (ONE platform-wide row) | yes | yes, a person of its spaces (U3) | no (U3) | no | no | no |
| Set another member's nickname | no | no | no | **yes, unless muted** (today: muted or not, U4) [NICK] | clear their own | no |
| Handle a reported nickname | **recourse** (today: the only queue, with no tool, U5) [NICK] | no | no | **yes** (today: never sees it) [NICK] | - | a member reports |
| Suspend an account | open question | - | - | - | - | - |

- (U1) `CS/users/users.controller.ts` behind `GlobalAdminGuard`, fields in `CS/users/profile-edit.service.ts`.
- (U2) `PATCH /users/me` is the bio's only writer (`CS/users/dto/user.dto.ts`); `profile-edit.service.ts` does not cover it.
- (U3) `mayModerateUser` (`bdeModeratesUserSql`); one row per person, any BDE of theirs may lift it (owner, 2026-11-02, "Laisser tel quel"). The withdrawn-broadcasters list and the one-account standing read (`LivesController`, 1.7.0) ask `isContentModerator` first and then this predicate (list: per row; account: `refuseModeration` out of scope), the withdrawal's own authority, server-side.
- (U4) `CommunityNicknamesService.set` (`SS/channels/community-nicknames.service.ts`) and the rule it asks, `mayWriteCommunityNickname` (`SS/channels/community-nicknames.ts`), read no mute.
- (U5) `reportInBdeScopeSql` has no `nickname` branch; only a CM clears one.

### Communities and salons (encrypted) - unchanged, already the target

| Action | AP | BM | CA | CM | Salon manager (`channel.manage`) | AU | Member |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Read a message | no route | no route | if a member of the salon | same | same | yes | yes |
| Delete another's message (purges a sent CanaReel) | no | no | yes | yes | yes | their own | no |
| Pin a message | no | no | yes | yes | yes | no | no |
| Exclude a member | no | no | yes | yes, bounded by its own rights | no | - | no |
| Delete a salon / the community | no | no | yes / yes | no | salon only | - | no |
| Report a message | does not exist (a privacy decision, [moderation-and-blocking](moderation-and-blocking.md#what-can-be-reported)) | - | - | - | - | - | - |

`SS/channels/` reads no `x-global-admin`; the community roles are `SS/channels/permissions.ts`, the
delete `SS/channels/channel.service.ts` with `SS/channels/moderation-grant.ts`, the exclusion
`permissionsCover` (the last admin is protected).

### DMs and groups (MLS) - every member equal

| Action | AP | BM | GM (any admitted member) | Non-member |
| --- | --- | --- | --- | --- |
| Read | no | no | yes, on their device | no |
| Add someone | no, explicitly | no | yes | no |
| Remove someone | no | no | yes, anyone (decision 10) | no |
| Group admin role | - | - | **none, all members equal** (today: an unread `role` column says otherwise) [MLS] | - |
| Report a message | does not exist | - | - | - |
| Block (refuses an add, a call, a 1-to-1) | - | - | yes | - |

`assertCallerMayMutateMembership` (`CD/controllers/members.controller.ts`, "A PLATFORM GLOBAL ADMIN IS
NOT EXEMPT"). The `role` column (`CD/entities/group-member.entity.ts`) is written `member` by
`CD/utils/group-membership.ts` and read nowhere - to drop.

### Reports - which queue, and what follows

ONE store, `content_reports`, ONE queue filtered by scope (`reportInBdeScopeSql`).

| Reported | Who may report | Queue (target) | Today, where it differs | The act |
| --- | --- | --- | --- | --- |
| `post` | who may open it | AP + the post's regulator (BM, or IM for its institution) | - | hide, delete, unmask |
| `comment` | who may read it | AP + the comment's regulator | - | delete; the place owner's hide needs no report |
| `user` | anyone signed in | AP + BM of the person's spaces | - | mute, erase the bio |
| `live`, `live_chat` | who may watch it | AP + the live's regulator; a `live_chat` line also the bureau | **the bureau: never** [LIVE] | cut, hide the line (also after the end, decision 18), mute |
| `nickname` | a member of the community | CM of that community, AP as recourse | **AP only** [NICK] | clear it |
| content gone | - | AP | - | review only |

Reviewing (`reviewed` / `dismissed`) is the regulator's, in scope (`SS/moderation/moderation.service.ts`).
A reporter sees no status and may not re-file after a dismissal (409 `ALREADY_REPORTED`).

### The journal and the notice

| Who sees | What | Target | Today |
| --- | --- | --- | --- |
| The other moderators of the same place (owner: *"BDE, bureau, institution"*) and the AP - per act, the lead's reading, reversible: the BDE's `MODERATE` members for a BDE act, the bureau for a place owner's act, the institution's IM for its acts | every act: hide, unhide, delete, unmask, a moderation read, a mute, a bio erasure, a cut, a place owner's hide (decision 13) | **a journal entry: who, what, when, the reason** | **server logs only, read by nobody in the app** [JOURNAL] |
| The person whose content was hidden or deleted, or whose bio was erased (decisions 14, 16); also a muted person - the lead's reading, reversible | which PLACE acted (the association, the BDE, the institution, the platform admin), never the person; the reason when one was given; no appeal in the app (decision 14) | **an in-app notice**, and a read-only view of their own hidden content (the lead's reading, reversible) | **nothing** [NOTICE] |
| The writer of a comment the place owner hid | nothing - a silent act (decision 15) | nothing | nothing (no such hide yet) |

### Blocks - private, outside moderation

A block is seen and lifted by its author only; no AP and no BM sees one; a block never stops the AP's
moderation read (`allowHidden` passes it, `SS/posts/post-openable.ts`). Unchanged: the reasons are in
[moderation-and-blocking](moderation-and-blocking.md#blocking).

---

## Sanctions

| Sanction | Who | What it covers (target) | Today |
| --- | --- | --- | --- |
| Mute (one row, platform-wide) | AP, BM of the person's spaces | posts, reactions, comments, republications, reposts, follow requests, lives and their chat, **votes, comment likes, community nicknames** | votes and comment likes are refused to a muted account - a comment like only when it ADDS one: a muted account may take back a like it holds, judged by state in `PostInteractionsService.likeComment`, like `removeReaction` (owner's lead, 2026-11-23) (`votePoll`, `likeComment` call `assertNotMuted` first, `SS/posts/posts.controller.ts`; the served `canVote` and `canLikeComments` read the mute, so the client draws them disabled; `posts.controller.mute-coverage.spec.ts` fails a write route that neither asks the mute nor is exempt); **nicknames are not checked** [NICK] |
| Outside the mute, deliberately | - | community and salon messages, DMs and groups: each place regulates itself (decision 9) | same |
| Not decided | - | events, forms | not covered |
| Broadcast ladder | AP, BM | warning, 30-day suspension of broadcasting, withdrawal ([lives](services/lives.md#the-strike-ladder-wp-l8b)) | same |
| Bio erasure | AP, BM of the person's spaces | the bio emptied, never rewritten (decision 16) | **does not exist** [BIO] |
| Account suspension | - | [decided 2026-11-19, not built](backlog.d/a-platform-admin-suspends-an-account-in-canari.md) | does not exist |

---

## The gaps and the work that closes them

| Tag | Gap | Closed by | Target |
| --- | --- | --- | --- |
| `GRID` | nothing asserts this page | [the grid as table-driven specs](backlog.d/the-moderation-authority-grid-is-asserted-by-table-driven-specs.md) | `1.8.0` |
| `HIDE` | a post's owner cannot act on a comment under it | [the place owner hides](backlog.d/p2-a-post-owner-hides-a-comment-under-it.md) | `1.9.0` |
| `NICK` | a reported nickname reaches a queue with no tool; a muted moderator renames | [nicknames to the community](backlog.d/p2-a-reported-community-nickname-reaches-the-community-moderators.md) | `1.9.0` |
| `LIVE` | an association's live belongs to its broadcaster alone; a chat line cannot be hidden after the end | [the live's moderators](backlog.d/p2-an-association-live-is-moderated-by-its-co-holders.md) | `1.9.0` |
| `AGENDA` | a BDE, a super-admin and the AP rewrite another body's event or form | [validate, never rewrite](backlog.d/p2-a-bde-validates-an-event-but-never-rewrites-it.md) | `1.9.0` |
| `JOURNAL` | no moderator sees what its peers did | [the journal](backlog.d/p2-every-moderation-act-is-journaled-for-its-peers.md) | `1.9.0` |
| `NOTICE` | a moderated person is never told | [the notice](backlog.d/p2-a-moderated-person-is-told-which-place-acted.md) | `1.9.0` |
| `BIO` | a bio cannot be erased by anyone but its owner | [bio erasure](backlog.d/p2-a-moderator-erases-a-bio.md) | `1.9.0` |
| `AUTOHIDE` | a massively reported comment stays up | [auto-hide for comments](backlog.d/p2-auto-hide-extends-to-comments.md) | `1.9.0` |
| `MLS` | an unread `role` column promises group admins | [drop the column (held migration)](backlog.d/p3-the-unread-mls-group-role-column-is-dropped.md) | `1.9.0` |

The P1 entries and the grid spec they are proven by go first, in `1.8.0` (the plan's order: P1 first);
the rest are the newest entries of the backlog and take `1.9.0` under the owner's order of 2026-11-11
(the slow-link chantier, then the oldest entries first; [note](decisions/owner-decisions-of-2026-11-11.md)).

**Found, and not decided** - cells nobody has ruled on, listed so they are not mistaken for
decisions. None is planned.

- Auto-hide of a live as a whole (decision 17 covers comments, and leaves chat lines out).
- A reporter is never told what became of their report (decision 14 is about the person reported).
- An event and a form cannot be reported.

## Open questions

- **Account suspension** - [decided 2026-11-19, not built](backlog.d/a-platform-admin-suspends-an-account-in-canari.md).

## How the grid is asserted

A grid nobody tests drifts from the code within a week. [The grid WP](backlog.d/the-moderation-authority-grid-is-asserted-by-table-driven-specs.md)
writes it as ONE table-driven spec per service, each row `{ grid, action, role, expected }` named
after a row and a column of this page, run on the real predicates:

- `apps/social-service/src/moderation/moderation-authority.grid.integration.spec.ts` - posts,
  comments, lives, agenda, forms, people, the reports queue and the journal, against PostgreSQL, on
  one fixture: a space governed by a BDE, a space governed by an institution with no BDE, an
  association under the BDE, a parentless association, an institution, a community, and one person
  per role.
- `apps/chat-delivery-service/src/controllers/members.controller.grid.spec.ts` - every admitted member
  adds and removes; a platform admin is refused like any non-member.

**A gap is countable**: every grid cell carrying a bracketed tag is one `it.todo` naming that tag (a
cell with two tags is one row per tag), and the work package turns its rows into
assertions in the pull request that closes it.
