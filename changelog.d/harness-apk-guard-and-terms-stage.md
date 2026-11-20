### Fixed - the rig's APK bundle guard tells a CSP allowlist from a request target, and its sign-in finds a terms page whose box is not laid out

`a1apk.mjs` refused every dev build because the `connect-src` allowlist (a list of hosts, not a request target) names production origins; the guard now recognises a CSP source list by its shape, and keeps refusing a lone production literal. `login.mjs` classifies the terms stage by its `cgu_accept` box whether or not it is laid out, and an unclassified page now names its controls in the error ([harness README](tools/cross-client-harness/README.md)).
