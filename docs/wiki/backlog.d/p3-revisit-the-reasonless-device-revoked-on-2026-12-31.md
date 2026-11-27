## P3 - revisit the `DEVICE_REVOKED` refusal that carries no reason, on 2026-12-31

target: 1.8.6

A dated commitment that had no entry until the replanning of 2026-11-27: once no server without
migration 040 can answer, the accusing wording about an older server in
`classifyRevokedDeviceRefusal` goes; the safe reading (an unexplained `DEVICE_REVOKED` is the owner's)
stays. Measure first that every estate runs 040, then remove. Details in
[legacy-compatibility](../legacy-compatibility.md#revisit-2026-12-31---a-device_revoked-refusal-that-does-not-say-who-revoked-the-device).
If `1.8.6` ships before 2026-12-31, this moves to `1.8.7`.
