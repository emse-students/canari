## Reading owed - legacy tier tags without a consistent issuer

target: 1.7.0

**What is built:** legacy tier tags without a consistent issuer ([cotisations](../cotisations.md#a-tag-counts-only-for-the-association-that-issued-it))

**The reading that closes it:** `tools/read-only-sql/tier-tags-without-a-consistent-issuer.sql`, read-only, on dev then production with the owner: 0 in every column closes it
