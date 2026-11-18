## P3 - a link that stalls is declared unreachable with the words "transport failure"

target: 1.7.1

Read on dev, `1.7.0-alpha.11`, sitting S4 (2026-11-18,
[readings](../device-verification.md#the-web-rig-readings-of-2026-11-18-s4-170-alpha11-the-false-accusers-cost-and-the-web-rows)):
a web seat whose `/api/*` requests were held unanswered by CDP `Fetch` printed, twice,

```
[CONNECTIVITY] GET /api/users/batch had no response after 20000 ms (read, 0 body byte(s)) (stall 1/2)
[CONNECTIVITY] GET /api/users/me/blocks had no response after 20000 ms (read, 0 body byte(s)) (stall 2/2)
[CONNECTIVITY] server unreachable (transport failure)
```

The verdict was reached by two request DEADLINES, not by a transport failure: no request failed
before an answer. `notifyServerUnreachable()` in `connectivity.svelte.ts` prints the same sentence for
both of its callers (the second stall in `failed`, and `isTransportFailure`), so a reader of a phone log
cannot tell a black-holed link from a refused socket - the distinction the stall counter exists for.
Unchanged since 2026-08-05 (`49b6775014`), so not a regression of `1.7.0`.

**The fix:** the caller states the evidence - `notifyServerUnreachable('2 request deadlines in a row')`
and `('transport failure: <kind>')` - and the line prints it; `connectivity.test.ts` pins both
sentences. About an hour.
