### Fixed - the iPhone keeps a CallKit ring the page does not ring, and never files an answered call as missed

The handover ends an unanswered CallKit ring only when the page rings that very call, a statement from a previous page is ignored, an answered call ended before the handover leaves no record, and the ring's deadline ends an answered call as failed rather than unanswered ([calls](docs/wiki/frontend/modules/calls.md#the-handover-ends-an-unanswered-ring-only-when-the-page-rings-that-call-2026-10-31)).
