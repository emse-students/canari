## P3 - a group joined from a Welcome on the iPhone reads "Utilisateur inconnu a ajouté Utilisateur inconnu au groupe"

target: 1.7.0

**Seen 2026-11-15 (iPhone 12, `1.7.0-alpha.1`, dev, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-15-170-alpha1-second-sitting)):** `delta` minted a group "I1700b nouveau groupe" with `gamma` in it; the phone had no record of the group (`[CanariNSE] outcome=fallback cause=group-absent;direct=mls-refused`), so it joined from the Welcome. The conversation's first system line then read "Utilisateur inconnu a ajouté Utilisateur inconnu au groupe", and it stayed so after the conversation was closed and reopened, while the members are known accounts.

**Not known:** whether the names are looked up before the member directory is loaded and never refreshed, or whether the line is stored with the unresolved names. **To do:** reproduce with a fresh group on the Mi 9T (is it iOS-only?), then read how the system line resolves the two ids (the group-add system message) and resolve at render time rather than at write time.
