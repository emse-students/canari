### Fixed - an iPhone call answered from CallKit joins, and a CallKit decline reaches the caller

A page PushKit launched in the background stays `visible`, so nothing drained the answer and its heartbeat refused the decline's save; the handover now tells the page, and the heartbeat guards only a loaded session ([calls](docs/wiki/frontend/modules/calls.md#the-iphones-answer-never-joined-and-its-decline-never-left-152-alpha2-2026-10-31)).
