### Changed - why Lydia refused `business/addcashier`

Lydia checks a request's signature over URL-encoded values and wants `permissions` as a JSON array of names, while it signs its own callbacks over raw values - so callback verification stays raw ([lydia-api](docs/wiki/lydia-api.md#5b-what-lydias-own-documentation-says-read-2026-10-27)).
