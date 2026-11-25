## Reading owed - the MiConnect editor token's narrowed write path, on production

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

Built: the editor role no longer holds a global write right on users; its one write path is the flow
`miconnect-profile-write`, whose policy writes `name`, `attributes.profile` and the merge-mark keys on
person, non-superuser accounts and refuses everything else; `editor-reach.sh` reports, daily against
production, any grant beyond the released blueprint and any write the account authored outside that
path ([authentik](../infrastructure/authentik.md#the-profile-editors-one-write-path-181)). CI proves
each refusal by using the token (`test-profile-editor.py`).

The reading that closes it, after the stable that ships it (`1.8.1`): the stable's blueprint apply prints a `REVOKED`
line for the role `miconnect-profile-editor`; the next `drift` run's editor-reach step is green
on production; and one admin profile correction made from Canari on production lands (a
`[PROFILE_WRITE] written` line in the MiConnect worker log, the profile changed in Canari).
