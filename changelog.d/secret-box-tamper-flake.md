### Fixed - the secret-box tamper test no longer passes an untampered box about one run in sixteen

It swapped the last base64url character, whose padding bits the decoder ignores; it now flips a decoded byte (`apps/social-service/src/common/secret-box.spec.ts`).
