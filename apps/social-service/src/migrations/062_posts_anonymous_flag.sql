-- A personal post can be marked anonymous at creation (user request, 2026-09-17): every reader
-- loses `authorId` except a content moderator or platform admin, mirroring the stripping an
-- association post already gets unconditionally (see `PostsService.viewerCapabilities`'s own
-- docblock) - the difference here is that it is VIEWER-conditional rather than universal, because
-- an admin still needs to be able to act on an anonymous post's real author.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false;
