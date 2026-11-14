## Reading owed - a burst of Welcomes costs two restores

target: 1.7.0

**What is built:** a burst of Welcomes costs two restores (#2094, `v1.3.0`)

**The reading that closes it:** the count of `[RESTORE] ... seeded` lines on a new device joining many groups

**Read 2026-11-14 on dev (`1.6.12-alpha.2`, two desktop Chrome profiles, test accounts):** an ordinary load seeds the rows ONCE (`[RESTORE] n conversation row(s) seeded`, one line per load); the burst of a NEW device joining many groups is still owed.
