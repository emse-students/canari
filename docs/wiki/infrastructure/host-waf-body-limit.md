# The host WAF drops any request body over 10 MiB (measured 2026-10-10)

**Fact.** On the Portail-etu host (production, `canari.emse.fr`), the school-managed **CrowdSec AppSec**
in the host nginx (`/etc/nginx/conf.d/crowdsec_nginx.conf`, a file we do not own) drops every request
whose body exceeds **10 485 760 bytes (10 MiB)**, for every user, on every connection. The client gets a
**403 with an HTML body** (`<title>CrowdSec Ban</title>`, 5.75 KB), after the whole body has been sent.
It is not a slow-link problem and no retry changes it.

## Evidence

- **The user's console export** (`console-export-2026-10-10_1-8-22.log`, production web, 13.4 MB PDF):
  `[media] encryptAndUpload: application/pdf, 14049945 bytes, single block`, an XHR `POST
  /api/media/upload` answered **403 in ~1 s** with that HTML page, then the outbox logged `transient
  failure (attempt N): MediaUploadError: media upload failed (403 ) - <!DOCTYPE html>` and retried in a
  loop; the bubble spun for ever.
- **curl, by the coordinator**: a 1 KB POST gets the origin's own `401` JSON; a 14 MB POST gets
  `100-continue` then the `403` CrowdSec page.
- **The host's own log** (`ssh portail-etu-direct`, `/var/log/crowdsec.log`): `request body exceeds limit
  10485760 bytes, will drop request` and `WAF block: request body exceeded maximum allowed size`.
- **Do not probe it again with big bodies from a workstation**: each one is an alert on a school-managed
  security stack. The probe of 2026-10-10 created a CrowdSec alert on IP **90.38.224.160**. Reproduce with
  the mock instead (`media.bodyBudget.test.ts`).

## What the app does about it (WP-OFF-8, [offline-and-weak-network](../frontend/offline-and-weak-network.md#13-audit-of-2026-10-10-a-13-mb-attachment-on-a-poor-link-and-what-navigation-waits-for))

- **No body over 8 MiB is built.** `utils/mediaRequestLimits.ts`: `GATEWAY_MAX_BODY_BYTES` = 10 MiB (the
  host) and `MEDIA_REQUEST_BODY_BUDGET_BYTES` = 8 MiB, the single-request ceiling and the chunk size
  (2 MiB left for the multipart envelope). A bigger ciphertext takes the existing chunked route
  (`upload/chunk/init`, chunks, `complete`); `fetchUpload` refuses to send a body over the host limit.
  The media-service 100 MB chunked policy and 50 MB `maxBytes` are unchanged.
- **A refusal is an answer, never transient.** `MediaUploadError` carries status and origin (HTML =
  `gateway`); the outbox ends the entry with `blocked` / `refused` / `too-large`, an error bubble with the
  delete action, and a notice in the thread. `blocked` is ONLY a gateway 403 HTML page; other gateway
  statuses are retried. A failed chunk session is released with `DELETE /api/media/upload/chunk/:id`.
- **Raise the constants only after the host's limit is raised AND re-measured.**

## What else POSTs a big body

Everything chat, salon, post, comment, reel and camera goes through `MediaService.encryptAndUpload` and is
covered. **Not covered, listed in the [backlog](../backlog.md#p2---the-host-waf-drops-any-request-body-over-10-mib-found-2026-10-10)**:
the association document vault (`AssociationDocumentManager.svelte` posts the packed document as ONE
`/api/media/upload` through `apiFetch`, no cap), the raw image uploads (`uploadRaw` for avatars and community
icons, `associations/api.ts` logos, product, partnership and event images, `forms/api.ts` banners and
question images: one multipart POST of the file as picked, no client cap), and the encrypted backup is a
download, not a POST. MLS blobs and history are small JSON/protobuf frames.

## Owed to the user

Ask the host admins whether the AppSec body limit can be raised (or exempted) for `/api/media/upload`
and the chunk routes. It is not in our hands. Until then 8 MiB per request is the rule, and a file still
goes up, in more requests.
