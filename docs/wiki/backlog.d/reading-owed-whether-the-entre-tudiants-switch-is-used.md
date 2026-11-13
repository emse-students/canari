## Reading owed - whether the "Entre étudiants" switch is used

target: 1.7.0

**What is built:** whether the "Entre étudiants" switch is used ([profiles-and-access](../profiles-and-access.md#the-students-only-switch-as-built-owner-2026-11-04))

**The reading that closes it:** on production, read-only: `SELECT count(*) FROM posts WHERE "studentsOnly"`
