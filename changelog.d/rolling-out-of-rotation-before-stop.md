### Fixed - a deploy could still answer 502 to a message sent while a replica was retired

Closing a retiring replica's listener reset the connections still waiting in its accept queue, after
nginx had sent the POST into them (1 in 346 on main's CI). `rolling.sh` now takes the replica out of
rotation first and proves its accept queue empty before stopping it
([cicd](docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)).
