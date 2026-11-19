### Removed - the last of Stripe in the code and the database

Two held migrations drop the three dead Stripe columns and rewrite the stored `stripe` payment method to `online`; the shims, tests, copy strips and comments kept only for Stripe went with them. The two columns that still carry a `stripe*` name hold the live Lydia references and stay ([stripe-archive](docs/wiki/stripe-archive.md#the-last-removal-owner-2026-11-19-tu-peux-tout-supprimer-en-ce-qui-concerne-stripe)).
