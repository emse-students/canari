# shellcheck shell=bash
#
# The things a COPY of production's database must not carry, in ONE place.
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
}
