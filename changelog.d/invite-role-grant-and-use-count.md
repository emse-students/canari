### Fixed - an invitation grants only a role the inviter may grant, and invite use counting is atomic

A direct invitation grants the base role unless its author could grant the named role through role management; accepting a link claims a use in one conditional statement, so `maxUses` holds under concurrency ([social-service](docs/wiki/services/social-service.md#an-invitation-grants-only-a-role-the-inviter-may-grant-2026-10-22)).
