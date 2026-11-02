## P2 - governance follows reach: an association reaching two BDEs' spaces is governed by either (proposal written 2026-11-02)

The owner chose "the BDE of origin alone" for content crossing spaces, but `holdsBdeFlagOverSql`
(`apps/social-service/src/spaces/bde.ts`) grants validation and management to the BDE of ANY space
an association's audience reaches; on a campus split between two BDEs the default whole-campus
audience puts every new association under both, and the per-campus audience bound lets each BDE
rewrite the other's audiences. `MODERATE` is still global, the moderator tier may edit others'
posts, and a BDE manages the members of an institution reaching its space. The proposal - at most
one governing home BDE per entity, set by hand by the platform admin with a journal, reach kept
inside the home's spaces, every BDE bound per formation x campus, a per-item audience that narrows a
post or an event, events validated per BDE slice, work packages WP-R0 to WP-R5, WP-I and WP-E, and
the owner's open questions - is
[spaces-and-audiences-reform](../spaces-and-audiences-reform.md). Nothing is built; the data changes
wait for the owner's yes.
