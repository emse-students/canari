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
composed by every target kind; a comment is now judged by its post, its own publisher and its replies'
publishers (`bdeModeratesCommentSql`, `mayModerateComment`, and `moderatesCommentThread` for the served
bin). A refusal is typed `MODERATION_RESERVED_TO_PLATFORM_ADMIN` and worded by the client. Proof:
`bde-moderation.integration.spec.ts` (real PostgreSQL, the matrix BDE A / BDE B / an institution / a
club of each / a student, and the platform admin). The mechanism and the decisions taken are in
[moderation-and-blocking](../moderation-and-blocking.md#who-may-read-the-queue).

**Owed:** the release, then this file and its queue line are deleted.
