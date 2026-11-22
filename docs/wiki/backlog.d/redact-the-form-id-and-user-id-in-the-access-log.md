## P3 - the access log pairs a client address with an anonymous form's URL, and an address with a `userId`

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Found in the review of the anonymous cursus join (owner decision of 2026-11-21, [forms](../frontend/modules/forms.md#an-anonymous-form-may-read-the-cursus-from-the-account-owner-2026-11-21)).
Two linkages in the HTTP access log, both older than that feature and both outside any service log
line (which now name neither the account nor the form on an anonymous submit):

- `POST /api/forms/<id>/submit` records the form's URL with the client address - for every anonymous
  form, a network address next to the form a person answered.
- The `/api/ws` lines pair the client address with the `userId`.

Fix, either or both: redact the form id for the submit routes in the access-log format (the route
template instead of the path), or drop `userId` from the `/api/ws` access-log line. Name the test that
would catch a regression: an nginx log-format check in the infrastructure tests. The register
([C8](../compliance/register-of-processing.md)) states the linkage as it stands until then.
