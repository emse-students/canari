### Fixed - the build: a follower row's profile link uses SvelteKit 3's typed route

`FollowPersonRow` resolves `/profile/[id]` with its parameter, the shape SvelteKit 3's typed `resolve()` accepts; the bare template path failed `bun run check` on `main`.
