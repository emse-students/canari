## Reading owed - the first observed legacy cotisation claim

target: 1.7.0

1429 rows are staged on dev and on production; the projection (60 production accounts will be granted
at their next sign-in, 248 close `already-held`) is on
[cotisations](../cotisations.md#what-the-load-did-projected-on-production-shipped-2026-09-11-v0171). What
is missing is a single observed claim: the next sign-in should move `/admin/legacy-cotisations` off zero
in the claimed tab, and until it does an empty screen and a broken claim look identical. The service
log line and that page have never been read against a real claim.
