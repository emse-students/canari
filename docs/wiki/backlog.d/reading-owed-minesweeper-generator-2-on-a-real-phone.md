## Reading owed - Minesweeper generator 2 on a real phone, in the app (2026-11-14)

target: 1.7.0

Built, tested and in review (#3474); what is owed is what a test cannot give. **The reading:** on a phone
that has only met generator 1, play two or three real Challenge games IN THE APP and say whether the first
dig's wait is acceptable and the boards still feel worth playing. The target (60) comes from one person
on one phone playing eight prepared boards, so the score weights and the target are the knobs - and moving
either is a NEW generator version, never an edit.

**And one count on dev, with it:** `minesweeper generation fell back` (the replay's warning, logged when no
layout the v2 solver clears was found in three starts) read 0 over 800 boards on a workstation; count it on dev
before trusting that number.

[minesweeper](../frontend/modules/minesweeper.md#generator-v2-owner-2026-11-13).
