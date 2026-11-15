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

It follows two principles of the charter ([principes](../principes.md)):

- **5, "Une communaute, pas une audience"** - Canari is made *with* those who make it live: students,
  the School, the associations. A place's own people regulate it, as they already run it.
- **4, "Independants pour l'essentiel"** - no decision of everyday life depends on one central
  operator. A platform admin queue that every incident must cross is that dependency.

Principle 1 bounds it: in the ENCRYPTED world (communities, salons, DMs, groups) no platform role and
no BDE has any route at all - the place's own members regulate it, on what they can decrypt.

## The decisions of 2026-11-15 (owner)

Quoted as given; the grids below apply them.

1. **The principle above**, "Chaque lieu se regule seul".
2. **The moderation READ follows `mayModeratePost`.** A hidden post, its comments, a replay: a BDE
   moderator reads them within its scope, every read logged; the platform admin participates only as
   an ordinary reader. Built by [PR #3561](https://github.com/emse-students/canari/pull/3561) (the
   replay's moderation read and the admin's ordinary participation; owner, the same day: *"La
   moderation des lives doit avoir le meme regulateur que les posts. Donc ouvrir."*) and a sibling pull
   request for the post and its comment page - **not planned again here**.
3. **An institution's `MODERATE` member does NOT moderate students.** The door and the scope count
   only governors of type `association` (`governorIsAnAssociationSql`); a space with no BDE stays with
   the platform admin. [WP](backlog.d/p1-institution-moderators-moderate-their-own-content-not-students.md).
4. **An institution's own `MODERATE` members moderate that institution's own content** - its posts,
   its lives, the comments under them - and the platform admin keeps recourse. Same WP.
5. **The author of a post, or the `POST_AS_ASSO` holders for an association's post, may HIDE (never
   delete) another person's comment under it**: a tombstone like moderation's, never revealing an
   anonymous writer. [WP](backlog.d/p2-a-post-owner-hides-a-comment-under-it.md).
6. **A reported community nickname goes to that community's moderators**, the platform admin as
   recourse; **a muted person cannot set nicknames**.
   [WP](backlog.d/p2-a-reported-community-nickname-reaches-the-community-moderators.md).
7. **An association's live is ended and moderated (chat lines, viewers) by its other `POST_AS_ASSO`
   holders**, not only by the broadcaster.
   [WP](backlog.d/p2-an-association-live-is-moderated-by-its-co-holders.md).
8. **Agenda: a BDE validates, rejects or deletes an event, but never rewrites another body's event
   text.** The same rule for **forms**, which the platform admin and the parent BDE's super-admin edit
   today. [WP](backlog.d/p2-a-bde-validates-an-event-but-never-rewrites-it.md).
9. **Sanctions: the mute extends to votes, comment likes and nicknames.** Community and group messages
   stay outside it - each place regulates itself. Account suspension touches MiConnect and is a
   [question](open-questions.md#should-canari-suspend-an-account-asked-2026-11-15).
   [WP](backlog.d/p2-the-mute-covers-votes-and-comment-likes.md).
10. **Encrypted groups (MLS): ALL MEMBERS ARE EQUAL.** *"A quoi sert un role d'admin dans les groupes ?
    Les communautes oui, les groupes, tout le monde est a egalite non ?"* The unread `role` column of
    `dm_group_members` and its misleading comment go; removing a member stays open to every member.
    [WP, a held migration](backlog.d/p3-the-unread-mls-group-role-column-is-dropped.md).
11. **The writer of an association's post is visible to its moderators** (the platform admin, the
    BDE in scope), as an association comment's already is; **the raw `authorId` of `/posts/hidden` is
    closed.** [WP](backlog.d/p1-hidden-posts-list-serves-an-association-post-s-raw-writer.md).
12. **Still OPEN**: whether a moderator may erase a bio - [below](#open-questions), not planned.

---

## The roles

| Role | Short | What defines it in the code |
| --- | --- | --- |
| Platform admin | **AP** | the JWT's `admin` claim, forwarded by nginx as `x-global-admin: true` (`SS/common/guards/global-admin.guard.ts`, `GlobalAdminGuard`); granted by another admin only |
| BDE moderator | **BM** | `MODERATE` (bit 7) in an association of type `association` that governs a space (`isContentModerator`, `SS/associations/associations.service.ts`); every act then asks its SCOPE (`SS/spaces/bde-moderation.ts`) |
| Institution moderator | **IM** | `MODERATE` in an institution. TARGET: moderates the institution's own content only (decision 4). TODAY: counted as a BM when the institution governs a space (`callerHasAnyBdeFlag` filters the type for `MANAGE_ASSO` only; `bdeStandingInSpaceSql` reads no type), and nothing over the institution's own content (`governingBdeJoinSql` excludes institutions) |
| Holder | **HO** | `POST_AS_ASSO` in the association, list or institution that published the thing: "the author" of every post and comment in its name (`isPublisherOf`, `SS/posts/posts.service.ts`) |
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
| a person (personal, anonymous, "Entre etudiants", a CanaReel, a replay) | the BM of any space the author belongs to (`bdeModeratesUserSql`) | also the IM of an institution governing one of those spaces |
| an association or a list with a parent BDE | the parent BDE's BM (`bdeModeratesPublisherSql`, WP-D2) | - |
| a BDE | its own `MODERATE` members (`governingBdeJoinSql`: a BDE governs itself) | - |
| an institution | **its own IM**, AP as recourse | AP only (`MODERATION_RESERVED_TO_PLATFORM_ADMIN`) |
| an association with no parent, a person with no space | AP - a place with no regulator | - |
| a student of a space whose governor is an institution, no BDE | AP - a place with no regulator | the institution's IM |

---

## The grids

Cell legend: **yes** / **no** / **-** (does not apply). A cell in **bold** whose text says
`today: ...` is a GAP: the target differs from the code, and the bracketed WP closes it. `in scope`
means the scope of the role, as the table above defines it.

### Posts (association, list, institution, BDE, personal, anonymous, CanaReels, replays)

| Action | AP | BM | IM (own institution's post) | HO | AU (personal) | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Moderation read: a hidden or out-of-audience post, its comments, its replay - logged | yes (P1) | **yes in scope** (today: no, P1 - #3561 and sibling) | **yes** (today: no) [IM] | no | no | no |
| Participate (react, comment, vote, report) outside the audience | **no** (today: yes, P2 - #3561) | no | no | no | - | no |
| Hide / unhide | yes | yes in scope (P3) | **yes** (today: no, AP only, P4) [IM] | no | no | no |
| Delete | yes | yes in scope (P5) | **yes** (today: only if HO too) [IM] | yes | yes | no |
| Unmask an anonymous post (one-way) | yes | yes in scope (P6) | - | - | no | no |
| See the real author of an anonymous post | yes | yes in scope (P7) | - | - | yes, their own | no |
| See the writer of an association's post | **yes** (today: no on the card, the raw id on `/posts/hidden`, P8) [WR] | **yes in scope** (same) [WR] | **yes** (lead's reading of 4 + 11) [IM] | no | - | no |
| Edit the text | no (P9) | no (P9) | no | yes | yes | no |
| Pin in a space (a promotion, not moderation) | yes | yes in its BDE's spaces, any publisher (P10) | no | no | no | no |
| Auto-hide | - | - | - | - | - | 5 pending reports hide it (P11) |

- (P1) `SS/posts/posts.controller.ts` `getPost` passes `allowHidden` for `x-global-admin` only; `SS/posts/post-openable.ts` refuses `hidden` otherwise. A BM judges from the 250-character preview of the queue and the bare markdown of `GET /posts/hidden`. The replay half is [PR #3561](https://github.com/emse-students/canari/pull/3561); the post and comment page half its sibling (decision 2).
- (P2) `readPostOpenVerdict` passes `adminSeesAll: true` for every intent (`SS/posts/post-openable.ts`); #3561 keeps it to the moderation read.
- (P3) `assertModeratesPost` -> `mayModeratePost` (`SS/posts/posts.controller.ts`, hide/unhide/unmask routes).
- (P4) `bdeModeratesPublisherSql` is false for an institution (`governingBdeJoinSql`: `child.type <> 'institution'`), so `refuseModeration` answers `MODERATION_RESERVED_TO_PLATFORM_ADMIN`.
- (P5) `assertMayManage` (`SS/posts/posts.service.ts`): AP, `isPublisherOf`, or `mayModeratePost`.
- (P6) `PATCH /posts/:postId/unmask`, behind `assertModeratesPost`.
- (P7) `mustHideAnonymousAuthor` (`SS/posts/posts.service.ts`).
- (P8) `shapeListRow` and `toPublicPostFromEntity` delete `authorId` from every association post for every reader; `getHiddenPosts` selects the raw `p."authorId"` and the controller returns it unshaped.
- (P9) `assertMayEdit` -> 403 `POST_EDIT_PUBLISHER_ONLY` (owner, 2026-11-02, [D23 amended](profiles-and-access.md#d23-amended---moderate-is-scoped-and-only-the-author-edits-a-post-2026-11-02)).
- (P10) `SS/posts/space-pins.ts`: `MODERATE` in the BDE OF THE SPACE (owner: pinning is not moderating).
- (P11) `SS/moderation/moderation.service.ts`, `createReport` - posts only.

### Comments (plain, anonymous, in an association's name)

"Place owner" is the post's AU for a personal post, its HO for an association's (decision 5).

| Action | AP | BM (post AND comment's publisher in scope) | IM (under its own post, or in its name) | Place owner | HO of the comment's association | AU of the comment | RD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Moderation read under a hidden post | yes (C1) | **yes in scope** (today: no, C1 - sibling of #3561) | **yes** (today: no) [IM] | no | no | no | no |
| See the real writer (anonymous, association) | yes (C2) | yes in scope (C2) | **yes** (today: no) [IM] | **no, never** | no | yes, their own | no |
| Hide another's comment (tombstone, reversible) | (delete covers it) | (delete covers it) | (delete covers it) | **yes** (today: no, C3) [HIDE] | - | - | no |
| Delete (a tombstone where a protected reply stays) | yes (C4) | yes in scope (C4) | **yes** (today: no, AP only) [IM] | **no** - hide only | yes | yes, with its thread (C5) | no |
| Edit the text | no (C6) | no (C6) | no | no | yes | yes | no |
| Delete from the reports queue | yes | yes in scope (C7) | **yes** [IM] | - | - | - | - |

- (C1) `SS/posts/posts.service.ts` `listComments`: `allowHidden` = `opts.isGlobalAdmin`.
- (C2) `seesAccount` (`SS/posts/comment-identity.ts`); the post's author has no reveal right.
- (C3) `commentRights` (`SS/posts/comment-identity.ts`) knows only the comment's author and its moderators; no column and no route hide a comment.
- (C4) `commentRights.canDelete`, `bdeModeratesCommentSql`, `planCommentRemoval` (`SS/posts/comment-removal.ts`).
- (C5) `PostInteractionsService.deleteComment` (`SS/posts/post-interactions.service.ts`).
- (C6) 403 `COMMENT_EDIT_AUTHOR_ONLY` (`SS/spaces/bde-moderation.ts`).
- (C7) `mayModerateComment` (`SS/associations/associations.service.ts`).

### Lives, their chat, cuts and replays

| Action | AP | BM | IM (own institution's live) | HO (association / institution live, not broadcasting) | BC | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Watch outside the audience | no (review cohort only, L1) | no | no | no | yes | no |
| Moderation read of a replay | yes | yes in scope (#3561) | **yes** [IM] | no | yes | no |
| End the live | via a cut | via a cut | via a cut | **yes** (today: no, L2) [LIVE] | yes | no |
| Cut (ends it, records a strike) | yes | yes in scope (L3) | **yes** (today: no) [IM] | no | - | no |
| Hide a chat line, live open | yes | yes in scope (L4) | **yes** [IM] | **yes** (today: no, L4) [LIVE] | yes | no |
| Remove a viewer | no | no | no | **yes** (today: no, L5) [LIVE] | yes | no |
| Withdraw or restore the right to broadcast (a person) | yes | yes, a person of its spaces (L6) | **no** (today: yes for a governed space's students) [IM] | no | no | no |
| Hide / delete a replay | as a post | as a post | as a post [IM] | delete | delete | no |

- (L1) `WATCH_ONLY = { adminSeesCohort: true }` (`SS/lives/lives.service.ts`).
- (L2) `POST /lives/:id/end`: `LivesService.end` checks the `broadcasterId`.
- (L3) `POST /lives/:id/cut`: `assertStaff`, then `mayModerateLive` (`bdeModeratesLiveSql`).
- (L4) `LiveChatService` hide: `own || isStaff`, refused 410 once `endedAt` is set, staff included.
- (L5) `POST /lives/:id/removed-viewers`: `LivesService.removeViewer` answers 404 to anyone but the broadcaster.
- (L6) `POST /lives/broadcasters/:userId/withdrawal`: `assertStaff`, then `mayModerateUser`.

### Agenda events

| Action | AP | AV (targeted space) | SA (parent BDE) | Organiser (`PROPOSE_EVENT`) | Accepted co-organiser | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Validate / reject | yes (E1) | yes, an institution's event included (E1) | no, unless also AV | no | no | no |
| Edit the text or the date | **no** (today: yes, E2) [AGENDA] | **no** (today: yes, E2) [AGENDA] | **no** (today: yes through `mayAct`, E2 - flagged) [AGENDA] | yes | text and poster only | no |
| Delete | yes | yes | yes | yes | no | no |
| Report | does not exist (E3) | - | - | - | - | - |

- (E1) `mayValidateEvent`, `holdsBdeAgendaRightOverSql` (`SS/spaces/bde.ts`): the agenda follows the spaces an event TARGETS, not the parent (owner, 2026-11-03).
- (E2) `assertMayWriteEvent` (`SS/associations/associations.service.ts`): a global admin, `mayValidateEvent`, or `mayAct(PROPOSE_EVENT)` - which a parent super-admin passes. The same gate guards `PATCH` and `DELETE /associations/:id/events/:eventId`.
- (E3) `REPORT_CONTENT_TYPES` names no event.

### Forms and polls

| Action | AP | SA (parent BDE) | `MANAGE_FORMS` holder | Personal form's owner | BM | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Edit an association form's questions or text | **no** (today: yes, F1) [AGENDA] | **no** (today: yes, F1 - flagged) [AGENDA] | yes | - | no | no |
| Close or delete an association form | yes (recourse) | yes | yes | - | no | no |
| Edit / delete a personal form | **no edit** (today: yes, F1) [AGENDA]; delete yes | - | - | yes | no | no |
| Report a form | does not exist | - | - | - | - | - |
| A post's poll | follows its post | - | - | - | follows its post | - |
| Close a salon poll | no | no | - | its author | no | CM: yes (F2) |

- (F1) `managesForm` (`SS/forms/form-ownership.ts`): a global admin; `MANAGE_FORMS` through `mayAct`, which a parent super-admin passes (`MANAGE_FORMS` is not in `SUPER_ADMIN_EXCLUDED_FLAGS`); a personal form's owner.
- (F2) `SS/channels/channel.service.ts`, the salon poll close.

### People: profile, mute, community nicknames

| Action | AP | BM | IM | CM (of the community) | The person | RD |
| --- | --- | --- | --- | --- | --- | --- |
| Edit name, campus, cursus, roles (identity provider fields) | yes (U1) | no | no | no | asks a correction | no |
| Erase a bio | **open question** (today: no, U2) | **open question** | no | no | yes | no |
| Report a person | - | - | - | - | - | yes |
| Mute / unmute (ONE platform-wide row) | yes | yes, a person of its spaces (U3) | **no** (today: yes, a governed space's students) [IM] | no | no | no |
| Set another member's nickname | no | no | no | yes, **unless muted** (today: muted or not, U4) [NICK] | clear their own | no |
| Handle a reported nickname | **recourse** (today: the only queue, with no tool, U5) [NICK] | no | no | **yes** (today: never sees it) [NICK] | - | a member reports |
| Suspend an account | **open question** | - | - | - | - | - |

- (U1) `CS/users/users.controller.ts` behind `GlobalAdminGuard`, fields in `CS/users/profile-edit.service.ts`.
- (U2) `PATCH /users/me` is the bio's only writer (`CS/users/dto/user.dto.ts`).
- (U3) `mayModerateUser` (`bdeModeratesUserSql`); one row per person, any BDE of theirs may lift it (owner, 2026-11-02, "Laisser tel quel").
- (U4) `CommunityNicknamesService.set` and `mayWriteCommunityNickname` (`SS/channels/community-nicknames.ts`) read no mute.
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
| Report a message | does not exist | - | - | - |
| Block (refuses an add, a call, a 1-to-1) | - | - | yes | - |

`assertCallerMayMutateMembership` (`CD/controllers/members.controller.ts`, "A PLATFORM GLOBAL ADMIN IS
NOT EXEMPT"). The `role` column (`CD/entities/group-member.entity.ts`) is written `member` by
`CD/utils/group-membership.ts` and read nowhere - **to drop** [MLS].

### Reports - which queue, and what follows

ONE store, `content_reports`, ONE queue filtered by scope (`reportInBdeScopeSql`).

| Reported | Who may report | Queue (target) | Today, where it differs | The act |
| --- | --- | --- | --- | --- |
| `post` | who may open it | AP + the post's regulator (BM, or IM for its institution) | IM: never | hide, delete, unmask |
| `comment` | who may read it | AP + the comment's regulator | IM: never | delete; the place owner's hide needs no report |
| `user` | anyone signed in | AP + BM of the person's spaces | also the IM of a governed space [IM] | mute |
| `live`, `live_chat` | who may watch it | AP + the live's regulator | IM: never | cut, hide the line, mute |
| `nickname` | a member of the community | **CM of that community**, AP as recourse | AP only [NICK] | clear it |
| content gone | - | AP | - | review only |

Reviewing (`reviewed` / `dismissed`) is the regulator's, in scope (`SS/moderation/moderation.service.ts`).
A reporter sees no status and may not re-file after a dismissal (409 `ALREADY_REPORTED`).

### Blocks - private, outside moderation

A block is seen and lifted by its author only; no AP and no BM sees one; a block never stops the AP's
moderation read (`allowHidden` passes it, `SS/posts/post-openable.ts`). Unchanged: the reasons are in
[moderation-and-blocking](moderation-and-blocking.md#blocking).

---

## Sanctions

| Sanction | Who | What it covers (target) | Today |
| --- | --- | --- | --- |
| Mute (one row, platform-wide) | AP, BM of the person's spaces | posts, reactions, comments, republications, reposts, follow requests, lives and their chat, **votes, comment likes, community nicknames** | votes and comment likes are not checked (`votePoll`, `likeComment` in `SS/posts/posts.controller.ts`), nor nicknames [MUTE] [NICK] |
| Outside the mute, deliberately | - | community and salon messages, DMs and groups: each place regulates itself (decision 9) | same |
| Not decided | - | events, forms | not covered |
| Broadcast ladder | AP, BM | warning, 30-day suspension of broadcasting, withdrawal ([lives](services/lives.md#the-strike-ladder-wp-l8b)) | same |
| Account suspension | - | [open question](open-questions.md#should-canari-suspend-an-account-asked-2026-11-15) | does not exist |

---

## The gaps and the work packages that close them

| Tag | Gap | Work package | Target |
| --- | --- | --- | --- |
| [GRID] | nothing asserts this page | [the grid as table-driven specs](backlog.d/the-moderation-authority-grid-is-asserted-by-table-driven-specs.md) | `1.8.0` |
| [IM] | an institution's MODERATE moderates students, and not its own content | [institution moderators](backlog.d/p1-institution-moderators-moderate-their-own-content-not-students.md) | `1.8.0` |
| [WR] | an association post's writer: hidden from moderators on the card, raw on `/posts/hidden` | [the writer and the hidden list](backlog.d/p1-hidden-posts-list-serves-an-association-post-s-raw-writer.md) | `1.8.0` |
| [HIDE] | a post's owner cannot act on a comment under it | [the place owner hides](backlog.d/p2-a-post-owner-hides-a-comment-under-it.md) | `1.9.0` |
| [NICK] | a reported nickname reaches a queue with no tool; a muted moderator renames | [nicknames to the community](backlog.d/p2-a-reported-community-nickname-reaches-the-community-moderators.md) | `1.9.0` |
| [LIVE] | an association's live belongs to its broadcaster alone | [co-holders moderate the live](backlog.d/p2-an-association-live-is-moderated-by-its-co-holders.md) | `1.9.0` |
| [AGENDA] | a BDE, a super-admin and the AP rewrite another body's event or form | [validate, never rewrite](backlog.d/p2-a-bde-validates-an-event-but-never-rewrites-it.md) | `1.9.0` |
| [MUTE] | the mute ignores votes and comment likes | [the mute's gaps](backlog.d/p2-the-mute-covers-votes-and-comment-likes.md) | `1.9.0` |
| [MLS] | an unread `role` column promises group admins | [drop the column (held migration)](backlog.d/p3-the-unread-mls-group-role-column-is-dropped.md) | `1.9.0` |

The P1 entries and the grid spec they are proven by go first, in `1.8.0` (the plan's order: P1 first);
the rest are the newest entries of the backlog and take `1.9.0` under the owner's order of 2026-11-11
(the slow-link chantier, then the oldest entries first; [note](backlog.d/owner-decisions-of-2026-11-11.md)).

**Found, and not decided** - empty cells nobody has ruled on, listed so they are not mistaken for
decisions. None is planned.

- A live chat line can no longer be hidden once the live ended (410), while its report stays open up
  to 90 days: the moderator can only mute.
- Auto-hide counts posts only - never a comment, a chat line or a live.
- A reporter is never told what became of their report.
- An event and a form cannot be reported.

## Open questions

- **May a moderator erase a bio?** Today only the person writes it (`PATCH /users/me`), the AP's
  profile edit does not cover it, and a `user` report can end only in a mute, which leaves the bio up.
  **Recommended: erase only, never rewrite, by the AP and the BM in scope** - the post-integrity rule
  applied to a profile. **Not decided, not planned** (owner, 2026-11-15).
- **Account suspension** - [open-questions](open-questions.md#should-canari-suspend-an-account-asked-2026-11-15).

## How the grid is asserted

A grid nobody tests drifts from the code within a week. [The grid WP](backlog.d/the-moderation-authority-grid-is-asserted-by-table-driven-specs.md)
writes it as ONE table-driven spec per service, each row `{ grid, action, role, expected }` named
after a row and a column of this page, run on the real predicates:

- `apps/social-service/src/moderation/moderation-authority.grid.integration.spec.ts` - posts,
  comments, lives, agenda, forms, mute, nicknames and the reports queue, against PostgreSQL, on one
  fixture: a space governed by a BDE, a space governed by an institution with no BDE, an association
  under the BDE, a parentless association, an institution, a community, and one person per role.
- `apps/chat-delivery-service/src/controllers/members.controller.grid.spec.ts` - every admitted member
  adds and removes; a platform admin is refused like any non-member.

Each work package above flips its rows from today to the target in the pull request that builds it.
