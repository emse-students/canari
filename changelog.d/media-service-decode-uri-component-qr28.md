### Fixed - media-service's dependency audit is green again: GHSA-qr28-fpjm-wq7f rides the existing reachability premise

The new `decode-uri-component` advisory sits on the same `minio > query-string` edge as GHSA-vcc3-ghjq-m6fr; its fix is ESM-only and out of minio's range, so it is ignored under the same asserted premise and retires itself with it ([cicd](docs/wiki/cicd.md#five-audit-advisories-are-suppressed-on-one-edge-of-media-service-and-why-each-is-unreachable)).
