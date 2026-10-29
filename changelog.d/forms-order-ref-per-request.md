### Fixed - a paid form answer can be paid again after a declined payment

A retry reused the answer's Lydia `order_ref`, which Lydia refuses (error 3); every request now
carries its own, and callbacks of the old format still settle
([payments](docs/wiki/frontend/modules/payments.md#a-form-answer-sends-one-order_ref-per-request-2026-10-27)).
