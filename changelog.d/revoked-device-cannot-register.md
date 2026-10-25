### Security - a revoked device can no longer register a new device; the refusal says why

An access token now dies with its session at the verifier, revoking a device ends that device's sessions, and a banned device id is refused with a code naming who banned it, so a device its owner revoked signs out and is wiped rather than enrolling again ([sessions](docs/wiki/sessions.md#an-access-token-is-only-as-alive-as-its-session-2026-10-25), [chat-delivery](docs/wiki/services/chat-delivery.md)).
