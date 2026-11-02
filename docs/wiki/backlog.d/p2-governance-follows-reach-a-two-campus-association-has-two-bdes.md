## P2 - governance follows reach: an association reaching two BDEs' spaces is governed by either (proposal written 2026-11-02)

The owner chose "the BDE of origin alone" for content crossing spaces, but `holdsBdeFlagOverSql`
(`apps/social-service/src/spaces/bde.ts`) grants validation and management to the BDE of ANY space
an association's audience reaches; on a campus split between two BDEs the default whole-campus
audience puts every new association under both, and the per-campus audience bound lets each BDE
rewrite the other's audiences. `MODERATE` is still global, the moderator tier may edit others'
posts, and a BDE manages the members of an institution reaching its space. The proposal - audience
and dependencies as two independent axes with two admin panels, an association or list under at
most one BDE (two levels, enforced by triggers) and one governor per space, set by hand by the
platform admin with a journal, institution-only item narrowing, events and partnerships validated
per governor slice, a comparison of associations, lists and institutions, three quick wins that
ship before the reform (WP-Q1 partner rights, WP-Q2 an acceptance re-opens a validated event, WP-L
the list money gate), the reform's WP-R0, WP-R1, WP-D1, WP-D2, WP-R4, WP-I, WP-E and WP-R5, and the
owner's open questions - is
[spaces-and-audiences-reform](../spaces-and-audiences-reform.md). Nothing is built; the schema and
data changes wait for the owner's yes.
