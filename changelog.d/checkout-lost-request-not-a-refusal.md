### Fixed - a Lydia request whose answer was lost is no longer read as a refusal

Core answered a `request/do` timeout as a 400, which the boutique read as "nothing was created" and
closed the attempt while Lydia could still hold a payable request; core now answers 502, every
refusal it raises before Lydia is typed `CHECKOUT_REQUEST_INVALID`, and only a typed refusal code
releases an attempt or a form answer ([forms](docs/wiki/frontend/modules/forms.md#a-released-payment-is-resumed-on-the-same-answer-owner-decision-of-2026-11-21)).
