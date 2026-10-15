### Fixed - the migration 082 integration test failed on every run against a real Postgres

It created its throwaway schema after TypeORM had already read `current_schema()`, so its second `synchronize` found no tables and recreated `channel_workspaces`. The schema is now created first, as the other integration files do ([the spec](apps/social-service/src/channels/channel-unread-clear.integration.spec.ts)).
