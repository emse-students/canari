## P2 - the Alumni SSO: the free window, the link due mid second year, the cotisant gate, the merge

target: 1.8.0

**Owner, 2026-11-23**, planned in `1.8.0` by the owner's choice over the reliability-first order of
2026-11-19. The decisions are D42-D48 on
[profiles-and-access](../profiles-and-access.md) (WP8 re-decided), the only copy. The source itself has
been live, unpromoted, since 2026-11-23
([authentik](../infrastructure/authentik.md#the-alumni-saml-source-enabled-not-promoted-measured-2026-11-23)).

**MiConnect (blueprints): built, in review** - D45, D46, D43's read, D47, D44, D42-D43's gate, the
claim `alumni_linked`, and D49's page (live: the source is `POST_AUTO`, read on production 2026-11-23). Both limits are settled
by the lead (2026-11-23): the link cannot resume the authorization (authentik's Source stage is
Enterprise; accepted, reversible), and the sign-in handoff answers the gate and the step itself (`alumni_cotisant_required`,
`alumni_link_required`, lead 2026-11-23), from the case table both sides run
(`libs/contracts/alumni-access.json`). Readings owed on production, and the
dev smoke account to clear before the pre-release:
[as built](../infrastructure/authentik.md#the-alumni-sso-as-built-for-180-d42-d49-owner-2026-11-23).

**Canari: BUILT 2026-11-23** (the banner D44, the duplicates list D47, "Rattacher" D48, the editor
account proven) - [as built](../profiles-and-access.md#the-work-packages-in-order). authentik's API
serves a connection's `user` read-only, so "Rattacher" MARKS the duplicate and MiConnect moves the
link and deletes the duplicate at its next Alumni sign-in (`miconnect-alumni-merge-or-refuse`).
Owed: a reading once MiConnect emits `alumni_linked`, and the first real merge.

**GDPR: done with the blueprints** - the register (M1), Canari's privacy policy (`alumni_linked`) and
the MiConnect terms (page and notice, version `2026-11-24`, so everyone accepts again).

**Measured in the source (2026.8.6):** authentik resumes a flow after a source only through the
Enterprise Source stage; without it a signed-in link lands on the settings page, and the person signs
in to the application again. A link made from the settings page writes no property, so `cotisant` is
first read at the next Alumni sign-in.

**Readings owed for `1.8.0`, on production** (the lead's, with a real Alumni account; the steps are on
[authentik](../infrastructure/authentik.md#the-alumni-sso-as-built-for-180-d42-d49-owner-2026-11-23)):

1. an account CREATED through the Alumni button (the routing page, "I have none"): `alumni-<af_id>`,
   the Alumni e-mail, a membership read dated today;
2. a LINK through the CAS (the routing page, "I have a School account"): "Successfully linked" on the
   CAS account, `alumni_linked` true in Canari;
3. the `cotisant` READ at a later Alumni sign-in: `attributes.alumni.read_on` today, username and name
   unchanged;
4. the LINK STEP (D44): the reminder once per session, the block after its date;
5. D49 SIGNED IN: the confirmation page names the account, the tick goes on to Alumnforce, the link
   completes.
6. a REAL MERGE: the first flagged duplicate verified by an admin (Alumni e-mail, `af_id`, asserted
   name against the target's name, promo, last sign-in), marked, then signed in through Alumni -> the
   person lands in the target, the duplicate is gone, an Event `custom_alumni_merge` with its IP, and
   at the next reading of the admin page the duplicate's Canari account is erased.

### Set by hand before the 1.8.0 stable (2026-11-24)

Before the stable was cut, these accounts got NO cursus and the post `EMSE` in MiConnect, so that the
free window, the link step and the cotisant gate never lock them out (no cursus means no link step
ever; the post opens MiGallery and Le Cercle whatever the date, by OIDC and by the sign-in handoff):

- the dev smoke account (`DEV_SMOKE_USERNAME`, `development` environment);
- the review cohort on production: the service account behind `SERVICE_ACCOUNT_USER_ID`, the store
  reviewer and its counterpart.

A data change on MiConnect, the lead's; named here by variable and role only.

**DONE on 2026-11-24.** The review cohort and the dev smoke account now have no cursus and the post
`EMSE`. The service account behind `SERVICE_ACCOUNT_USER_ID` turned out to be the store reviewer
itself, so three accounts were changed. The rollback details are in the private operations
notes.
