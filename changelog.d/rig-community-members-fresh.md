### Fixed - the salon rows wait for the member row they act on

The community panel draws a member's row only once that member's profile has loaded. The rig's roster wait counted role controls, and the invite form's own control is one of them. So RM-4..6 looked for a member before the panel drew them. `markMemberRow` now polls for the row it needs ([cross-client-testing](docs/wiki/cross-client-testing.md)).
