## P3 - social-service assumes its container runs in UTC (review of #3979, 2026-11-22)

target: 1.8.0

Nothing sets `TZ` for social-service: its containers run in UTC only because the base image does.
The `submissions` dates are zone-less `timestamp` columns written on the UTC wall clock, and the
driver reads them back as that wall clock in the PROCESS's zone. Readers that format them (the
anonymous week cut `anonymousAnswerWeekOf`, the XLSX date cells, the responses list's UTC getters)
agree only while that zone is UTC. A process in another zone would shift an anonymous answer's
Monday 00:00 to a Sunday evening on the client.

**Fix, one of:** pin `TZ=UTC` in the social-service images and compose files (and assert it at
boot), or add a test that runs the date paths under a non-UTC `TZ`. Hardening only: nothing runs
outside UTC today ([forms](../frontend/modules/forms.md#an-anonymous-answer-keeps-only-its-week-2026-11-22)).
