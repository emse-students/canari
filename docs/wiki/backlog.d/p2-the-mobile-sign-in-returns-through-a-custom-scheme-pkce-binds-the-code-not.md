## P2 - The mobile sign-in returns through a custom scheme: PKCE binds the code, not the app (2026-10-23)

target: 1.9.0

PKCE (S256, [auth](../frontend/modules/auth.md#login-flow)) makes a code worthless to anybody who lacks
the verifier of the request that produced it. It does not say WHICH app receives the redirect: the
phone sign-in returns on `fr.emse.canari://callback`, a custom scheme the OS does not verify, and a
party that runs its own authorization runs its own PKCE too. What closes that is a redirect only
Canari can receive: an `https` callback on a verified host (`MOBILE_APP_LINK_HOSTS` in
`frontend/src/lib/mobile/appSiteAssociation.ts`, App Links on Android, Universal Links on iOS)
registered on the providers in `infrastructure/authentik/blueprints/50-providers.yaml`; then, once
`minClientVersion` covers it ([the floor rule](../legacy-compatibility.md#the-floor-rule-raised-when-both-stores-serve-the-latest-update-owner-2026-10-24)), the custom-scheme redirect URI comes off the providers and core-service
refuses a callback with no verifier
([legacy-compatibility](../legacy-compatibility.md#no-date-yet---an-oidc-callback-with-no-pkce-verifier)).
Owed first: whether `ASWebAuthenticationSession` and the Custom Tab both hand an `https` callback on a
claimed host back to the app on the bench phones, a reading, since no gate here sees it. Re-read
2026-11-11: `fr.emse.canari://callback` is still registered in `50-providers.yaml`; nothing moved.
