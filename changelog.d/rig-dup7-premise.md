### Changed - DUP-7 plays an Add that really happens, and names its unmet premise

On 1.4.1 an owner's new device seats itself by external join, so W1's Add of W3 never ran. DUP-7 now has W1 invite W4, the third account, through the product's invite path, with the commit's answer lost and the Welcome held, and W4 must receive ONE Welcome. A commit that never fires is reported as an unmet premise, not as FAIL. Pinned in `devrows-selftest.mjs` ([board](docs/wiki/cross-client-testing.md)).
