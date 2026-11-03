## Decided - the owner's answers of 2026-11-03 (evening)

Decisions, not open questions; this entry is deleted when the last one is carried out.

- **Play**: no stable is cut while the previous stable is in Play review, because a new stable
  replaces the one in review. Pre-releases (internal track) are fine.
- **Android wry wake pipe (#2974, merged)**: on end of file or a read error, log at error then abort
  deliberately, so the crash is visible in Play Vitals. Never leave a silently frozen UI.
- **Local message retention**: the 90-day local pruning stays as it is. It was first wrongly reported
  as dead code, then confirmed with the right facts.
- **Reform D1**: the proposed "entity -> parent BDE" list is validated as is; the owner may correct it
  later in production. **Built** (the list is in the reform page, 2.8; migration 130 applies it); its
  three migrations (129-131) wait for the owner's hand-merge of their approval lines.
- **Space pins (#2975 design)**: the build starts once #2953 has merged.
- **`1.6.3-alpha.3`**: cut it once #2949 and #2936 have merged. #2919 may follow in the next alpha.
- **Stable `1.6.3`**: the lead agent may cut it without the owner if Play has published `1.6.2` and
  alpha.3 reads well on the bench phones.
- **CanaReels writer switch (#2861)**: it goes in the alpha after alpha.3, after the RC-0 re-run and
  its readings. Never straight into a stable.
- **Sky #160**: its migration drops the `email` columns of `people` and `pending_links`. The owner
  approved shipping it; both columns were verified empty in that day's backup before release, and Sky
  `v1.1.11` shipped it.
