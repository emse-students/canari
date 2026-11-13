## Reading owed - the KeyPackage minting loop on a handset across background and resume

target: 1.7.0

Population, refuted causes and rules are on [key-package-pool](../protocols/key-package-pool.md), the only copy. **Owed, in order:** (1) one CDP console read (not logcat) of the reload path across a background/resume on a real handset, looking for `[RESUME]` and the `publishedThisSession` refusal counter; (2) a device-side state census (groups, members, one-time bundles, last-resort); (3) the per-connection fallback reuse. The shipped guard closes the observed case, not the class: `publishedThisSession` is per-process, so a keystore emptied and then RESTARTED would run the loop again.
