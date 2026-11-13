## Reading owed - a changed profile photo revalidated at the edge

target: 1.7.0

The shape and the layers table are on
[core-service](../services/core-service.md#no-cache--the-upstream-etag-and-the-busted-url-it-did-not-need-2026-10-08).
**Owed, then delete this entry**: after the deploy, `curl -sI` a face twice through `canari.emse.fr`
and confirm Cloudflare revalidates (`cf-cache-status` not a `HIT` with a growing `Age`), then change a
photo in MiGallery and watch it appear. If the avatar Cache Rule overrides the origin, the fix is that
rule.
