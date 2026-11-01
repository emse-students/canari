### Fixed - a deploy could still answer 502 to a message sent while a replica was retired

Closing a retiring replica's listener reset the connections still waiting in its accept queue, after
nginx had sent the POST into them (1 in 346 on main's CI). The frontend and the edge now choose
replicas from lists the deploy writes; a replica leaves its list, by a reload proven to have taken
effect, before it is stopped
([cicd](docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)).
