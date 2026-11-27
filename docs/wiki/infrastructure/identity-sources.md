# Identity sources: what the CAS and the Alumni SSO send, and what MiConnect keeps

MiConnect (authentik) does not hold passwords. A person signs in through one of two upstream
identity providers, called **sources** in authentik. MiConnect then builds its own account from what
the source sent, and hands its own claims to the applications. This page documents the data at
each of those three stages. Every row is MEASURED on production, with the date and the method. Only
attribute and claim NAMES and SHAPES were read, never the values. Configuration and flows are on
[authentik](authentik.md); the profile model is on [profiles-and-access](../profiles-and-access.md).

```
  CAS EMSE (OIDC)  --\                              /--> Canari, Sky, MiGallery, Le Cercle,
                      >-- MiConnect account -------<      MinoWiki, the Reseau console
  Alumnforce (SAML) --/   (username, name, e-mail,  \--> their own claims (below), never the
                           attributes.profile, ...)       raw source data
```

## The CAS (`cas-emse`, OpenID Connect)

**Who:** students and School staff with a working School account. The account disappears when the
person leaves the School.

**Protocol:** OIDC authorization code with PKCE `S256`, against `https://cas.emse.fr/cas/oidc/`
(discovery at `.well-known/openid-configuration`, user info at `oidcProfile`). MiConnect is the client
`miconnect` and asks for the scopes `openid profile email`.

**What it returns** (user info), measured 2026-11-23 by a temporary log line in the source mapping
that recorded claim names and types on one real sign-in, then was removed:

| Claim | Type | Meaning |
| --- | --- | --- |
| `sub` | string | the School login, `prenom.nom` form (contains a dot). This is the subject MiConnect links on |
| `id` | string | the same login in the CAS's own field |
| `name` | string | full display name |
| `given_name` | string | first name |
| `family_name` | string | last name |
| `email` | string | the School address |
| `auth_time` | int | when the CAS authenticated the person (protocol) |
| `client_id`, `service` | string | the calling client (protocol), not about the person |

**What it does NOT return:** no affiliation, no track, no entry year, no student/staff flag. The
discovery document advertises 21 standard claims (`birthdate`, `gender`, `phone_number`,
`address`...), but none of them arrive. The person DECLARES their affiliation, track and entry year
at enrolment (D8, D11).

**What MiConnect keeps from it:**
- **at enrolment**: authentik's OIDC base properties (`username`, `email`, `name`), overridden by the
  mapping `miconnect-cas-identity`: `username = sub` (falling back to `id`), and `name = name`, or
  `given_name family_name`;
- **at every later sign-in**: nothing is rewritten. The link is the source connection, keyed on `sub`.

## The Alumni SSO (`alumni`, SAML 2.0)

**Who:** members of the Mines Saint-Etienne alumni network, on the Alumnforce platform run by Mevia.
Every student has an account there from entry (owner, 2026-11-23), and keeps it after leaving.

**Protocol:** SAML 2.0, SP-initiated only. MiConnect is the Service Provider:
- entityID and metadata: `https://miconnect.emse.fr/source/saml/alumni/metadata/`;
- ACS: `.../source/saml/alumni/acs/` (HTTP-POST);
- entry: `.../source/saml/alumni/`.

The IdP has entityID `alumnforce-mines-saint-etienne.org`; its metadata (public at
`https://mines-saint-etienne.org/sso/saml/metadata`) lists one SSO endpoint,
`https://mines-saint-etienne.org/sso/saml/ssoservice`, as HTTP-Redirect only. **The same endpoint
accepts a POSTed request** (read on production 2026-11-23, a cold sign-in and a repeat one): with the
source set to `POST_AUTO`, MiConnect ran its pre-authentication flow, auto-submitted the request by
POST, Alumnforce answered 303 to its own login page (which asks a second factor of its own), and the
assertion came back to the ACS and was accepted. So the source is `POST_AUTO`, which is what lets
MiConnect show the link confirmation (D49) first
([authentik](authentik.md#the-alumni-sso-as-built-for-180-d42-d49-owner-2026-11-23)).

**What it returns**, measured 2026-11-23 on a real sign-in by a temporary probe in the source mapping
(names, formats and algorithms only), then removed:

| Item | Shape | Meaning |
| --- | --- | --- |
| NameID | `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent`, a 5-digit number | the alumni id, equal to `af_id`. Stable across sign-ins. The IdP's metadata lists only `transient`, but asked for persistent it answers persistent |
| `af_id` | text, numeric | the alumni id (same value as the NameID) |
| `firstname` | text | first name |
| `lastname` | text | last name |
| `email` | text | the e-mail the person registered with Alumnforce |
| `cotisant` | text, `"1"` or `"0"` | whether the person is a paying member of the alumni association |

The attribute names are plain (`firstname`), not URIs. There is no `groups` attribute.

**Trust:** the Response AND the Assertion are each signed `rsa-sha256` with `sha256` digests. They
are verified against the IdP certificate pinned in the blueprint (`miconnect-alumni-idp-signing`,
self-signed, valid 2025-02-11 -> 2035-02-11). Nothing is encrypted. MiConnect's own requests are
unsigned (the source has no signing key pair).

**What MiConnect keeps from it** (since `1.8.0`; before, only the display name and, at enrolment,
the base properties):
- **at enrolment** (an alumni identity with no MiConnect account, after the routing page): the
  username `alumni-<af_id>` (the NameID), `name = firstname lastname`, the profile's `firstName` and
  `lastName` as sent, the Alumni `email` on the MiConnect account (D46), and the membership read;
- **at every sign-in** through the Alumni source: `attributes.alumni = {cotisant, read_on}` -
  `cotisant` as a boolean (`"1"` true, `"0"` false; any other value writes nothing and is logged)
  and the Paris date of the read. Nothing else is rewritten: a CAS account keeps its username, name
  and e-mail;
- **at a link** (the person was already signed in): only the source connection, keyed on the NameID.
  No property is written, so `cotisant` is first read at the next Alumni sign-in.

`cotisant` is never handed to an application in a claim. MiConnect uses it to decide access to
MiGallery and Le Cercle after the free window (D42-D43); Canari's core-service READS it, never
stores it, through its read-only account when it signs a person into one of those two sites, so it
signs in only someone MiConnect would let in (the handoff gate, same rule, same case table:
`libs/contracts/alumni-access.json`). How each piece is built:
[authentik](authentik.md#the-alumni-sso-as-built-for-180-d42-d49-owner-2026-11-23).

## What the applications receive from MiConnect

The applications never see the source data. They see MiConnect's claims, built from the MiConnect
account by the scope mappings in `10-mappings.yaml`. Which provider asks for which scope is in
`50-providers.yaml`.

| Scope | Claim | Built from |
| --- | --- | --- |
| `openid` | `sub` | `hashed_user_id`: a hash of the account, not the CAS login. authentik's default (2026.8.6 `OAuth2Provider.sub_mode`), PINNED since 2026-11-23 on the three site providers (`miconnect-cercle`, `-sky`, `-migallery`, owner's decision) because a site keys its accounts by it and a Canari handoff names it: production read `hashed_user_id` on all three before the pin, so no subject changed. The others keep the default |
| `email` | `email` | a SYNTHETIC `<username>@canari.emse.fr`, never the CAS or Alumni address |
| `school_mail` | `school_mail` | the REAL school address, lowercased: the account's `email` when the CAS CREATED the account (its `cas-emse` link's identifier is the username) and its domain is `etu.emse.fr` or `emse.fr` exactly (`libs/contracts/mail-domains.json`); ABSENT otherwise - an Alumni-created account (even CAS-linked later: its `email` is the Alumni one), no CAS link, another domain. Canari's three providers only (owner, 2026-11-27), for the school mailbox; Canari stores its class, never the address ([mail-client-transport](../mail-client-transport.md#eligibility)). Mapping `miconnect-claim-school-mail`, tested by `test-school-mail-claim.py` |
| `name` | `firstName`, `lastName` | `attributes.profile` |
| `profile` | `campus`, `cursus` (list of `{formation, promo}`), `posts` (list of `EMSE`/`ME`/`ALUMNI`) | `attributes.profile`, declared at enrolment, edited by admins only (D10) |
| `profile` | `miconnect_uuid` | the account's uuid, stable across sources (Canari's providers only) |
| `profile` | `alumni_linked` | `true` when the account holds the Alumni link, else `false` (Canari's providers only, since `1.8.0`): never the alumni id, never `cotisant` |
| `profile` | `avatar`, `minoGroups` | MiGallery's signed avatar URL; MinoWiki groups |
| `promo`, `formation` | `promo`, `formation` | the FIRST cursus, kept for older clients until WP9 |
| `school_status` | `school_status` | legacy, read by no application, removed by WP9 |

**Consequence:** an application cannot tell whether a person came through the CAS or the Alumni
SSO, and must not (D7: the provider is only a way in).
