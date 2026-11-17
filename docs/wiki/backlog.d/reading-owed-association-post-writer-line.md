## Reading owed - an association post's writer, drawn small under its name for its moderators (2026-11-17)

target: 1.7.0

**What is built:** the server serves `authorId` on a post published in an association's name to
whoever moderates it (the platform admin, a BDE whose spaces hold it) and to its writer, nobody else -
one rule, `viewerSeesWriter`, on the card, by id, in the feeds and the search, and on `/posts/hidden`,
which used to return the raw column ([moderation-authority](../moderation-authority.md), decision 11
and P8). The client draws it as the anonymous reveal is drawn: the association's name and logo big,
the writer small under it with a pen (`RevealedAuthorLine`, `under: 'association'`;
[posts](../frontend/modules/posts.md)). Proven by unit, PostgreSQL and component specs only.

**The reading that closes it:** on a pre-release, with a platform-admin bench account, open the
feed and an association's post: the association is the name, and one small line under it names the
officer who wrote it, linking their profile, the tooltip saying why it is shown. With a bench account
that holds no moderation right and is not the writer, the same post shows the association alone. The
"Posts masques" tab of `/admin/moderation` still names the writer of a hidden association post. Any writer
line shown to the plain account is a FAIL.
