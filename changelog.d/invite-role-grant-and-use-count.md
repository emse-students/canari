### Fixed - role grants and removals are bounded by the actor's own permissions, and invite use counting is atomic

An invitation, a role assignment, a permission edit, a new role and a removal each reach only as far as their author's own permissions (administrators keep everything); accepting a link claims a use in one conditional statement, so `maxUses` holds under concurrency ([social-service](docs/wiki/services/social-service.md#an-invitation-grants-only-a-role-the-inviter-may-grant-2026-10-22)).
