## An institution reaches the staff of its campuses beyond posts: shop, partnerships, directory, lives (owner, 2026-11-19)

target: 1.8.0

**Decided by the owner on 2026-11-19** (*"Oui, par campus, comme les posts"*,
[decisions](owner-decisions-of-2026-11-19.md)). The audience audit of 2026-11-14 found a staff account
(a campus, no cursus) sees nothing of an institution beyond its targeted posts: the shop
(`ProductsService`, `associationVisibleToViewerSql`), the partnerships (`PartnershipsService`), the
association directory and the institution's lives. They open to every staff account whose campus is
one the institution's audience rules reach - the same campus test as the posts' door
(`institutionReachStaffCampusDoorSql`), one SQL fragment shared, never a copy.

**Owed:** the association-level visibility predicate gains that staff-by-campus disjunct for
INSTITUTIONS only (an ordinary association is unchanged); integration specs per reader (staff of a
reached campus sees it, staff of another campus does not); re-read the agenda subscription and the
legacy no-reach posts and events against it; the as-built section of
[profiles-and-access](../profiles-and-access.md). Reversible: one disjunct.
