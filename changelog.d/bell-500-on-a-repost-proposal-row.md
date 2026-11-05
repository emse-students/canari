### Fixed - the bell answered 500 to any reader holding a repost-proposal row (dev only, `1.6.4-alpha.3`)

#3019 compared `post_notifications."associationId"`, a `uuid` column, through a varchar regex cast; it is now compared as it is. The bell's integration specs build that table from its migrations instead of a hand-written one that called the column a varchar ([post-notifications.it-schema.ts](apps/social-service/src/posts/post-notifications.it-schema.ts)).
