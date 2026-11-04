## P1 - no BDE moderates an institution's content; only the platform admin does (owner, 2026-11-03)

**Built (2026-11-04), owed its release.** The owner, 2026-11-03: no BDE moderates content published
in another BDE's or an institution's name - hiding, deleting, reviewing reports, editing, whatever the
path; only the platform admin does. A BDE keeps moderating, in the spaces it governs, what students
and the associations and lists it governs publish. It is the content half of "Aucun BDE n'a les droits
de gestion sur une institution" ([association-permissions](../association-permissions.md#the-grant-ceiling-who-may-write-which-bits-2026-11-02)).

**What was already true before this change.** #2953 scoped `MODERATE` through the management
predicate (`holdsBdeFlagOverSql`), which excludes an institution and another BDE: a post and a live in
such a name were already refused to every BDE, and editing is nobody's but the author's. The gap was
the **comment**: judged by its post alone, a comment in an institution's or another BDE's name under a
student's post was deletable (and its writer readable) by that post's BDE, directly, through the
reports queue, or through the delete of a parent comment taking its replies.

**What closed it.** ONE predicate, `bdeModeratesPublisherSql` (`apps/social-service/src/spaces/bde-moderation.ts`),
composed by every target kind; a comment is now judged by its post and its own publisher
(`bdeModeratesCommentSql`, `mayModerateComment`, and `moderatesComment` for the served bin). A
moderator's delete takes the descendants it moderates and leaves a moderation tombstone where a reply
it does not moderate must keep its context (lead, 2026-11-04); the tombstone carries no account, no
block hides it, it takes no reply or heart and is not counted, and every comment write holds the post
row (`writeComments`, the second review). A refusal is typed
`MODERATION_RESERVED_TO_PLATFORM_ADMIN` and worded by the client, the reports queue included. Proof:
`bde-moderation.integration.spec.ts` (real PostgreSQL, the matrix BDE A / BDE B / an institution / a
club of each / a list / a student, named and anonymous, and the platform admin; the tombstone through
the route). The mechanism, the decisions taken and the queue's measured cost are in
[moderation-and-blocking](../moderation-and-blocking.md#decisions-taken-2026-11-04-the-lead-reversible).

**Owed:** the stable (the dev reading passed on `1.6.4-alpha.2`, 2026-11-04, [device-verification](../device-verification.md#where-the-pass-stands)), then this file and its queue line are deleted. A student's content inside an
institution's or another BDE's post: **the place decides**, owner 2026-11-04, what ships
([moderation-and-blocking](../moderation-and-blocking.md#decided-by-the-owner-2026-11-04)).
An author's own delete takes the whole exchange, replies in a protected name included: owner,
2026-11-04, what ships.
