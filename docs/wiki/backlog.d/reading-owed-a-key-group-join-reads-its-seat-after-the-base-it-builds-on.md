## Reading owed - a key-group join reads its seat after the base it builds on

target: 1.7.0

**What is built:** a key-group join reads its seat after the base it builds on (#2721), and a refused external join logs every attempt and gives up as `refused` only after its third logged refusal (`BaseMlsService.ts`, `externalJoin`: every other exit names its own reason)

**The reading that closes it:** SALON-REVOKE-COMMIT and RM-4, RM-4b, RM-5 rerun on the current pre-release with consoles kept: no `already held - redelivered Welcome ignored` line in either spelling (key group, conversation), and any `could not join ... (refused)` preceded by attempts 1/3, 2/3 and 3/3
