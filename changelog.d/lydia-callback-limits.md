### Fixed - the Lydia callback route is bounded and its refusal line cannot be forged

Multipart parsing is capped, the refusal log carries at most 16 clean field names, and the signature check compares in constant time ([payments](docs/wiki/frontend/modules/payments.md)).
