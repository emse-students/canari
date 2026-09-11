-- Migration 059: the cotisations two legacy estates recorded, waiting for their holder to sign in.
--
-- Canari models a cotisation as a tag granted by an association (`user_tags`), and every path that
-- writes one goes through `grantCotisant`. Nothing seeds it: a member who paid the BDE or Le Cercle
-- BEFORE Canari existed arrives with no tag at all, and the association has no list to grant from
-- other than a spreadsheet.
--
-- Le Cercle's own migration out of its legacy database says so in as many words - "Doesn't take
-- into account the membership. Canari integration takes care of it." - and Canari never did. So the
-- dues are recorded in two places Canari cannot read:
--
--   * Le Cercle's pre-2026 SQLite base: 1168 cotisants with a usable identity, one `transaction` row
--     against the "Cotisation Cercle" consommable. 1175 of 1194 buyers paid exactly ONCE, which is
--     what makes `lifetime` the honest mode for it. The nominal price tracks inflation (26 EUR from
--     2017, 30 EUR from 2023) and says nothing about the forfait - the avec/sans-alcool split
--     post-dates the whole legacy estate, where the single cotisation always carried alcohol.
--   * The BDE's cotisant spreadsheet: 269 paid-up members across three year groups.
--
-- WHY A STAGING TABLE, AND NOT A ONE-SHOT GRANT. Canari holds 395 accounts against ~1400 legacy
-- cotisants: the overwhelming majority of the people on those lists have no account to grant a tag
-- to yet. A one-shot import could only serve the 395 and would silently drop the rest. The row
-- therefore waits here until the person signs in and is recognized.
--
-- WHY THE CLAIM IS NOT KEYED ON "FIRST LOGIN". `claimedByUserId` is the durable state, and it is
-- what terminates the claim - not a flag saying the account is new. Keying on first login would
-- strand everyone who signed into Canari before their list was loaded, and would make a failed
-- grant unrecoverable: the one moment it could have fired is gone. Attempted on every sign-in
-- against an indexed predicate that matches nothing once claimed, the import is self-healing and
-- order-independent instead.
--
-- Idempotent for CD.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_cotisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Normalized `<lastName>|<firstName>|<promo>`, built by `normalizeMatchKey` - the ONE
  -- implementation, shared by the import script and the claim, because two spellings of this key
  -- match nothing at all rather than matching wrongly. Neither legacy estate carries an email, and
  -- Canari's `users` table has no email column to match against, so the natural key is the only
  -- one available. Measured before choosing it: zero collisions among the 1169 Cercle cotisants
  -- carrying a promo, and zero inside any year group of the BDE sheet.
  "matchKey" varchar(200) NOT NULL,

  -- What the source said, verbatim, so a human arbitrating a refused row reads a person rather
  -- than a normalized key.
  "sourceLabel" varchar(200) NOT NULL,

  -- No foreign keys here, matching `user_tags`: `associationId` is social-service's own but
  -- `claimedByUserId` names a row in core-service's `users`, and the two are only colocated by
  -- deployment. A cascade across that boundary would be a service coupling the code does not have.
  "associationId" uuid NOT NULL,

  -- The tier to grant, validated against the association's own catalogue by `grantCotisant`.
  -- NULL means the base tier, which is what the BDE has; Le Cercle dropped its base tier, so its
  -- rows must name one (`avec-alcool`) or the grant is refused.
  "variantKey" varchar(100),

  -- Which load put the row here. Two estates, and possibly several passes over one of them.
  "sourceBatch" varchar(100) NOT NULL,

  -- Set together, by the claim, in the same transaction as the grant.
  "claimedByUserId" varchar(255),
  "claimedAt" timestamptz,

  metadata jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

-- At most ONE pending claim per (person, association). This is the control that makes an ambiguous
-- import fail at LOAD time, in front of whoever is running it and can still read the source, rather
-- than at some member's sign-in months later where the only possible outcome is to pick one row and
-- be silently wrong. Partial, because once a row is claimed it is history and must not block a
-- later, deliberate re-load.
CREATE UNIQUE INDEX IF NOT EXISTS "legacy_cotisations_pending_unique"
  ON legacy_cotisations ("matchKey", "associationId")
  WHERE "claimedByUserId" IS NULL;

COMMIT;
