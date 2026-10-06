### An upload that meets an expired token renews it and retries instead of signing you out

Every media upload route now refreshes the access token once and resends on a 401; only a 401 on the fresh token ends the session. See [sessions](../docs/wiki/sessions.md#implementation-traps). Test: `media.uploadRefreshRetry.test.ts`.
