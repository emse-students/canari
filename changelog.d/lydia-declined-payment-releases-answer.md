### Fixed - a declined Lydia payment no longer leaves the form answer pending with no retry

Lydia's state `5` (the payer declined) is now a typed `declined`, like `cancelled-or-expired`: the
answer is released and the form page and the return page offer the retry, where it used to read
"pending" and refuse a retry for up to 30 minutes ([forms](docs/wiki/frontend/modules/forms.md#a-declined-payment-releases-the-answer-2026-10-21)).
