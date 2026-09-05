# shellcheck shell=bash
#
# The things a COPY of production's database must not carry, and the ones it CANNOT carry, in ONE
# place.
#
# WHY THIS FILE EXISTS. There are now two copies of production: the weekly one into the
# dev.canari-emse.fr estate (`infrastructure/dev/copy-prod-to-dev.sh`) and the on-demand one into a
# developer's local stack (`infrastructure/local/restore-into-local.sh`, added 2026-09-02 when
# development moved local). The strip list's failure mode is an ABSENCE - a payment column added to
# an entity next month is a live identifier the copy would carry, with nothing to say so - and
# `.github/scripts/tests/dev-copy-guards.test.sh` DERIVES the list from the entity declarations to
# catch exactly that. A second hand-written copy of the list would be covered by nothing and would
# drift on the first change.
#
# The caller passes the name of ITS OWN guarded SQL function. Neither copy lets this file decide
# what it may write to: `copy-prod-to-dev.sh` re-checks the dev compose label on every call, and
# `restore-into-local.sh` re-checks the local one. That keeps the allowlist of writable targets in
# the script that owns the target, and keeps this file about WHAT is stripped rather than WHERE.
#
# Usage:
#   . "$ROOT/infrastructure/lib/copy-strips.sh"
#   apply_copy_strips dev_sql "$DATABASE" "[copy-prod-to-dev]"

# The ONE question that says whether (d) actually happened, kept in the file that owns (d) so the
# strip and its proof cannot drift apart. Both copies read it back in their step 5, and a copy that
# reports anything but 0 has rows pointing at objects it never received.
#
# It counts ROWS that still reference something, not references: the number is only ever compared
# against zero, and a per-column breakdown would be a second list to keep in step with the first.
#
# IT REPORTED 0 OVER THREE ROWS THAT STILL POINTED AT PRODUCTION'S OBJECT STORE, which is the exact
# failure the sentence above says cannot happen. A comment on a post can carry an attachment, and
# `posts.comments` is a jsonb ARRAY OF OBJECTS whose media sits one level down - so neither the
# column list here nor the strip below saw it, and a copy passed its own verification while the feed
# 404ed. Found by `pinrows.mjs --row 11` on 2026-09-05, whose only crime was to navigate W1 to the
# dashboard: `GET /api/media/4a805a13-... -> 404` twice, `[PostMedia] media download failed`, and a
# PASS-DIRTY on a row that had answered its question perfectly.
#
# **A LIST OF COLUMNS IS A CLAIM ABOUT A SCHEMA, AND IT GOES STALE IN SILENCE.** What settles it is
# not reading harder, it is asking the database: a loop over every text and jsonb column looking for
# `mediaId` and `/api/media/`, which is what found this one and answered nothing else on the schema
# of 2026-09-05. It is written out in
# `docs/wiki/infrastructure/databases.md#finding-every-media-reference-a-copy-carries-but-cannot-serve`
# rather than here, and it has to be: `dev-copy-guards.test.sh` fails the build if this file so much
# as mentions a container or a client, because the allowlist of writable targets belongs in the
# script that owns the target. Run it against a fresh copy after any schema change that adds a place
# a media reference can hide, and add whatever it names to BOTH the strip and the count.
# shellcheck disable=SC2034
COPY_STRIPS_MEDIA_RESIDUE_SQL="SELECT
    (SELECT count(*) FROM associations WHERE \"logoMediaId\" IS NOT NULL OR \"logoMediaId2\" IS NOT NULL OR \"logoUrl\" IS NOT NULL)
  + (SELECT count(*) FROM association_calendar_events WHERE \"imageMediaId\" IS NOT NULL OR \"imageUrl\" IS NOT NULL)
  + (SELECT count(*) FROM association_products WHERE \"iconMediaId\" IS NOT NULL)
  + (SELECT count(*) FROM partnership_cards WHERE \"iconMediaId\" IS NOT NULL)
  + (SELECT count(*) FROM forms WHERE \"imageMediaId\" IS NOT NULL OR \"imageUrl\" IS NOT NULL)
  + (SELECT count(*) FROM channel_workspaces WHERE \"imageMediaId\" IS NOT NULL)
  + (SELECT count(*) FROM dm_groups WHERE \"imageMediaId\" IS NOT NULL)
  + (SELECT count(*) FROM posts WHERE \"images\" <> '[]'::jsonb)
  + (SELECT count(*) FROM posts p WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p.\"comments\") c WHERE c ? 'media'))
  + (SELECT count(*) FROM channel_messages WHERE \"attachments\" <> '[]'::jsonb)
  + (SELECT count(*) FROM association_documents);"

# Applies every strip. $1 = name of the guarded sql function, $2 = database, $3 = log prefix.
apply_copy_strips() {
  local sql="$1" database="$2" prefix="$3"

  # (a) Push tokens belong to production's FCM sender and to real devices. Two independent reasons
  # to remove them: a shared sender would deliver a test notification to a member's phone, and a
  # different sender rejects every one of these rows - which would be 70-odd logged failures per
  # send, and noise is never acceptable. No foreign key references push_token, so TRUNCATE is safe
  # (checked). This matters MORE in a local stack than in dev, not less: a local `.env` built by
  # `env-from-prod.sh` carries production's own FIREBASE_SERVICE_ACCOUNT_JSON.
  "$sql" "TRUNCATE TABLE push_token;" "$database"
  printf '%s   push_token truncated\n' "$prefix"

  # (b) ALL SEVEN payment-provider columns, across four tables - seven rather than five because
  # `associations` carries a Lydia pair beside the Stripe pair (WP-LYDIA coexistence). Measured on
  # production 2026-09-01: 5 associations hold a real `stripeAccountId`; both Lydia columns are
  # empty so far, which is exactly why they are stripped now rather than when they are not.
  #
  # The REASON differs between the two targets and the action does not. In dev there is no Stripe
  # credential at all (user, 2026-09-01: "oublie. Stripe ne sera pas accessible en dev pour le
  # moment, tant pis"), so a copied identifier could only produce a misleading failure. In a local
  # stack the key is production's LIVE key (user, 2026-09-02), so a copied identifier is a real
  # customer, a real connected account or a real payment intent that a local mistake could act on.
  # Stripping makes nothing real ADDRESSABLE by accident in either case.
  #
  # The two `*OnboardingComplete` columns are NOT NULL booleans, so they are set false rather than
  # nulled - an association is not onboarded on an account the environment cannot reach.
  "$sql" "UPDATE users SET \"stripeCustomerId\" = NULL WHERE \"stripeCustomerId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE associations SET \"stripeAccountId\" = NULL WHERE \"stripeAccountId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE associations SET \"stripeOnboardingComplete\" = false WHERE \"stripeOnboardingComplete\";" "$database"
  "$sql" "UPDATE associations SET \"lydiaAccountId\" = NULL WHERE \"lydiaAccountId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE associations SET \"lydiaOnboardingComplete\" = false WHERE \"lydiaOnboardingComplete\";" "$database"
  "$sql" "UPDATE purchase_records SET \"stripePaymentIntentId\" = NULL WHERE \"stripePaymentIntentId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE submissions SET \"stripeSessionId\" = NULL WHERE \"stripeSessionId\" IS NOT NULL;" "$database"
  printf '%s   payment identifiers cleared: 7 columns across users, associations, purchase_records, submissions\n' "$prefix"

  # (c) platform_config.payment_provider is left ALONE, and that is a decision rather than an
  # oversight. Its type is 'stripe' | 'lydia' with no third value, so there is no way to say
  # "payments are off" - writing anything else would contradict what the code asserts about the
  # column. The consequence is that a copy presents Stripe as the live provider. That the platform
  # cannot declare payments disabled is a real gap, recorded in the backlog.
  printf '%s   platform_config.payment_provider left as-is (no "disabled" value exists - see backlog)\n' "$prefix"

  # (d) EVERY REFERENCE TO AN OBJECT THE COPY DID NOT RECEIVE. Both copies fetch a Postgres dump and
  # nothing else - neither touches Garage - so every media id in the restored rows names a blob that
  # exists only in production's store. The rows are not merely incomplete, they are INCONSISTENT, and
  # the product then does exactly the right thing with them: it asks for what its database says
  # exists, and is answered 404.
  #
  # MEASURED, NOT SUPPOSED (2026-09-04, HEAL-NEW-0 on the local estate). Every assertion of that row
  # held and the verdict was still PASS-DIRTY, with 100% of the dirt media: five
  # `[associationLogoCache] fetch failed 404`, one `[PostMedia] media download failed`, and fourteen
  # `GET /api/media/... -> 404`. The affected class is every check that lands on a social feed, which
  # is four whole rungs of the campaign - so this was never one row's noise to disposition, and
  # `ignoringExpectedLog` would have been the same excuse copied into four rungs, which is a wide
  # classifier wearing a per-row costume.
  #
  # CLEARING RATHER THAN COPYING THE BLOBS. Carrying production's object store would drag the half of
  # the estate that the database copy at least keeps behind one deliberate decision, and would buy
  # nothing: an association with no logo and a post with no image are states the product renders
  # correctly and a real user can be in. Self-consistent beats complete.
  #
  # THE URL COLUMNS GO WITH THE IDS, and they are the ones that actually bit. `logoUrl` holds
  # `/api/media/public/<uuid>`, a denormalised mirror of `logoMediaId`, and it is what
  # `associationLogoCache` fetches - so clearing the id alone would have left the 404s exactly where
  # they were. 89 of 89 association logos carried both on the estate this was measured on.
  "$sql" "UPDATE associations SET \"logoMediaId\" = NULL WHERE \"logoMediaId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE associations SET \"logoMediaId2\" = NULL WHERE \"logoMediaId2\" IS NOT NULL;" "$database"
  "$sql" "UPDATE associations SET \"logoUrl\" = NULL WHERE \"logoUrl\" IS NOT NULL;" "$database"
  "$sql" "UPDATE association_calendar_events SET \"imageMediaId\" = NULL WHERE \"imageMediaId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE association_calendar_events SET \"imageUrl\" = NULL WHERE \"imageUrl\" IS NOT NULL;" "$database"
  "$sql" "UPDATE association_products SET \"iconMediaId\" = NULL WHERE \"iconMediaId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE partnership_cards SET \"iconMediaId\" = NULL WHERE \"iconMediaId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE forms SET \"imageMediaId\" = NULL WHERE \"imageMediaId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE forms SET \"imageUrl\" = NULL WHERE \"imageUrl\" IS NOT NULL;" "$database"
  "$sql" "UPDATE channel_workspaces SET \"imageMediaId\" = NULL WHERE \"imageMediaId\" IS NOT NULL;" "$database"
  "$sql" "UPDATE dm_groups SET \"imageMediaId\" = NULL WHERE \"imageMediaId\" IS NOT NULL;" "$database"
  # The two jsonb collections are NOT NULL with a `[]` default, so they are emptied rather than
  # nulled - and compared against that literal rather than measured with `jsonb_array_length`, which
  # ERRORS on a jsonb value that is not an array instead of reporting one.
  "$sql" "UPDATE posts SET \"images\" = '[]'::jsonb WHERE \"images\" <> '[]'::jsonb;" "$database"
  # A COMMENT CAN CARRY AN ATTACHMENT TOO, and it is the one this list did not know about until a
  # campaign row navigated to the dashboard and read the console (see the residue query's own
  # comment). `comments` is an array of objects and the reference is a `media` OBJECT one level down,
  # so there is no column to null: the key is removed from each element and the array rebuilt in
  # order. `jsonb_agg` over no rows answers NULL rather than `[]`, and the column is NOT NULL.
  #
  # THE COMMENT ITSELF STAYS, unlike `association_documents` below, and the difference is that a
  # comment is ADDRESSABLE: replies carry their parent's id in `parentId`, so deleting one orphans
  # whatever hangs off it. A comment left with an empty body renders as an empty bubble, which is a
  # cosmetic oddity in a copy; an orphaned reply is a broken tree in one.
  "$sql" "UPDATE posts SET \"comments\" = coalesce((SELECT jsonb_agg(c - 'media' ORDER BY ord) FROM jsonb_array_elements(\"comments\") WITH ORDINALITY AS t(c, ord)), '[]'::jsonb) WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(\"comments\") c WHERE c ? 'media');" "$database"
  "$sql" "UPDATE channel_messages SET \"attachments\" = '[]'::jsonb WHERE \"attachments\" <> '[]'::jsonb;" "$database"
  # `association_documents` is DELETED rather than nulled, because its `mediaId` is NOT NULL: the row
  # has no way to express "the file is gone", nothing holds a foreign key to it (checked), and a row
  # whose entire content is a download that 404s is not a state a real user can be in.
  "$sql" "DELETE FROM association_documents WHERE \"mediaId\" IS NOT NULL;" "$database"
  printf '%s   media references cleared: a copy carries rows, never the objects behind them\n' "$prefix"
}
