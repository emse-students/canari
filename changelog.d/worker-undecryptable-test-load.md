### Fixed - the call worker's undecryptable-count tests no longer time out under a parallel run

The call worker's "undecryptable" counting tests no longer run 249 real AES-GCM attempts on the libuv thread pool, so they cannot time out when the whole suite runs in parallel. Test-only change.
