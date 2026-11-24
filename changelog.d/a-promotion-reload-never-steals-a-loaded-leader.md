### Fixed - two browser tabs promoted one after the other could take the lead from a tab already serving it

The page a promotion reload starts no longer steals the leader lock: it waits in the queue while no tab serves the lead and follows the tab that does, and a hidden leader hands the lead over only once its MLS work has settled ([chat](docs/wiki/frontend/modules/chat.md#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)).
