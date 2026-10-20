### Fixed - a call's E2E path check could pass trivially on a camera still negotiating (dev builds only)

The check now re-checks media it could not judge yet and again when a negotiation completes, keeps its earliest deadline, judges and reports the current peer connection's frames only, and a worker that stops answering withdraws the "encrypted end to end" claim ([calls](docs/wiki/frontend/modules/calls.md#call-e2e-bypass-mi9t-2026-10-20---chromium-short-circuits-a-transform-assigned-one-task-late)).
