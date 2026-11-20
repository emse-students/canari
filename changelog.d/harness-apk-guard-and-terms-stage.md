### Fixed - the rig's APK bundle guard tells a CSP allowlist from a request target

`a1apk.mjs` refused every dev build because the `connect-src` allowlist (a list of hosts, not a request target) names production origins; the guard now recognises a CSP source list by its shape, and keeps refusing a lone production literal ([harness README](tools/cross-client-harness/README.md)).
