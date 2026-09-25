### Fixed - unlocking a session still addressed the old hostname

Login itself worked on `canari.emse.fr`, then `Verifying PIN` died: `/api/mls/security/pin-salt` is
fetched from `mlsDeliveryHttp.ts`, which had rebuilt the same base-URL decision with the old
polarity and was missed when `apiUrl.ts` was fixed. Three callers had their own copy - the MLS
gateway/delivery pair, `useChatSession`'s history base, and `CallService` - and all three now
delegate to the one resolver
([estate-migration](docs/wiki/infrastructure/estate-migration.md#the-frontend-bakes-one-absolute-origin-per-build-and-phase-2-gave-it-two---login-broke-2026-09-25)).
