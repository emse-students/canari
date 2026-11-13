## The MiConnect profile reform - WP5 is next (decided 2026-09-29, re-read 2026-11-11)

target: 1.8.0

Thirty-two decisions and the eleven-package plan are on [profiles-and-access](../profiles-and-access.md),
the only copy. WP0, WPA, WP1, WP4 and WP6a-6b are in production (the spaces since `v1.2.0`).

**Next: WP5** - access to each application decided by MiConnect (D15): expression policies bound to
the applications, a group `acces-<app>` for nominative exceptions, then Sky deletes its ICM gate and
the Cercle drops `promo` and `formation` from `requiredClaims`. Not started on 2026-11-11: Sky still
gates on `SKY_ADMIN_SUBS` in its callback, and the Cercle's Authentik client still requires the two
claims. WP7-WP9 follow ([dependencies](../profiles-and-access.md)).
