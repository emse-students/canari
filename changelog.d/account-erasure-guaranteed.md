### Fixed - deleting an account is complete and guaranteed, not best effort

`DELETE /users/me` deactivates the account at once and queues one durable, retried, journalled erasure per service, accused daily when overdue; each service's delete set is asserted against its schema and now reaches comments, reactions, votes, form answers and authorship columns it used to miss ([account-erasure](docs/wiki/account-erasure.md)).
