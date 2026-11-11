### Removed - the CanaReels list has one switch, `multiMedia`

`singlePhotos`, `singleMedia` and `withLinks` are no longer read or sent: the `1.6.6` floor admits no
client that needed them, so the four list modes became one clause, links allowed
([reels](docs/wiki/services/reels.md#reading)).
A stale web tab of a pre-`1.6.6` bundle degrades rather than breaks: a `v1.6.5` bundle receives the link posts and drops them, and a tab older than `multiMedia` gets the reels only.
