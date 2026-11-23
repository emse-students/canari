## P2 - the Alumni SSO: the free window, the link due mid second year, the cotisant gate, the merge

target: 1.8.0

**Owner, 2026-11-23**, planned in `1.8.0` by the owner's choice over the reliability-first order of
2026-11-19. The decisions are D42-D48 on
[profiles-and-access](../profiles-and-access.md) (WP8 re-decided), the only copy. The source itself has
been live, unpromoted, since 2026-11-23
([authentik](../infrastructure/authentik.md#the-alumni-saml-source-enabled-not-promoted-measured-2026-11-23)).

**MiConnect (blueprints):**
- promote the source (D45);
- an account created through Alumni gets `alumni-<af_id>` and the e-mail (D46);
- a source authentication flow that writes `cotisant` + its read date at every Alumni sign-in (D43);
- the routing page before Alumni enrolment (D47);
- the reminder-then-blocking link step, per promo, with the 2027-02-01 grace (D44);
- an access policy per application: window OR post OR cotisant this calendar year (D42, D43). It
  is the same mechanism as WP5, see [the-miconnect-profile-reform-wp5-is-next](the-miconnect-profile-reform-wp5-is-next.md).

**Canari: BUILT 2026-11-23** (the banner D44, the duplicates list D47, "Rattacher" D48, the editor
account widened and proven) - [as built](../profiles-and-access.md#the-work-packages-in-order). The
link is NOT moved (authentik's API serves a connection's `user` read-only): the duplicate is deleted
and the person re-links from the banner. Owed: a reading once MiConnect emits `alumni_linked`.

**GDPR:** the e-mail and `cotisant` become kept data. The register (M1), the privacy policy and the
MiConnect terms notice change together. A new terms version makes everyone accept again.

**Open, to measure when built:** whether authentik continues a flow after a link started from a
stage (`SESSION_KEY_OVERRIDE_FLOW_TOKEN` in `flow_manager.py` says yes). A link made from the
settings page writes no property, so `cotisant` is first read at the next Alumni sign-in.
