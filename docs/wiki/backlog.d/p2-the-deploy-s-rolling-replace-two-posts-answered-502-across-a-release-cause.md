## Reading owed - a rolling replace's 502, at its next recurrence

target: 1.7.0

Re-read 2026-11-11: nothing new; the retired replica's error log is still deleted with it, so the next occurrence will be as unreadable as the first. Re-read again 2026-12-11.

`deploy-rolling.test.sh` (`make test-ci-scripts`, case 1, a release under load) failed ONCE: run 39796209603, attempt 1, head `537b4c736`. Tally `{"200":340,"502":2}`, slowest response 2155 ms, right after the frontend's old replica was retired with a 1 s drain. The rerun passed, and so does every other run read. The logs of attempt 1 are not retrievable: the API serves the passing attempt.

**What is known, by reading `infrastructure/lib/rolling.sh`, `infrastructure/edge/nginx.conf` and the fixture.**
- The edge is a LAYER 4 relay (`stream`). It cannot answer `502`: a connect it cannot make closes the client's connection instead (`transport:ECONNRESET` in the client's tally, as in the control case). So both 502s were written by a FRONTEND nginx whose upstream, `api`, failed after the request was handed to it. That rules out the edge's failover, and the accept-backlog reset of the retiring frontend, as the cause: either would show as a transport failure, not a 502.
- The 2155 ms is the edge's 2 s `proxy_connect_timeout` spent on the retired frontend's vanished address, then the next replica. That is the designed failover, and it answered 200.
- Not settled: WHICH frontend wrote the 502s, and what `api` did. Candidates:
  - the old frontend's worker, during its graceful SIGQUIT, failing a request that still needed `resolver` (a variable `proxy_pass`);
  - a frontend whose cached `api` set held only a retired address.

**Why it is not settled.**
- `retire` runs `docker rm` on the old replica, so its error log, the one line that names the hop, is gone with it.
- The test prints no frontend log when case 1 fails.
- Not reproduced locally.

**Owed, in order.**
1. Make the evidence survive: `retire` prints the retired replica's error lines before `rm`, and the test prints both frontends' logs when a POST fails.
2. Re-run case 1 until it fails, and read which hop wrote the 502.
3. Fix the order in the deploy library if the swap drops a request. A retry or a wider timeout is not the fix.

Filed from #2286.
