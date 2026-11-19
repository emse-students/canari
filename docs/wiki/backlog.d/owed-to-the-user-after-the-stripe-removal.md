## Owed after the Stripe removal - what is left (audited 2026-11-19)

target: 1.8.0

**Done:** the `STRIPE_*` GitHub secrets are gone (none in the repository's or the two environments' secret lists on 2026-11-19), and the CGU and privacy text naming Lydia was approved on 2026-10-08.

**Left, none of it code a session can do alone:** the Stripe webhook endpoint at the processor (the owner's dashboard); the unsigned Lydia partnership contract; proof that the payer e-mail is not kept (a promise to Lydia); and, once the previous release is no longer a rollback target, the migration dropping `associations."stripeAccountId"`, `"stripeOnboardingComplete"` and `users."stripeCustomerId"` (still created by `037_lydia_connect_columns.sql`, mapped by no entity) and renaming the permission ([stripe-archive](../stripe-archive.md#the-names-that-outlived-the-processor---what-2026-10-09-renamed-and-what-stays)). Association enrolment with conditions and documents is [its own line](three-open-items-the-claude-md-queue-alone-carried-moved-2026-10-22.md).
