### Fixed - a new device's join ask is sent and said once per state, not once per read

A further device of a member asks for a member's approval once per epoch pair of the group. The member
and the history answerer each say their decision once until what it rests on changes
([mls-recovery-ladder](docs/wiki/protocols/mls-recovery-ladder.md#a-further-device-asks-once-per-epoch-pair)).
