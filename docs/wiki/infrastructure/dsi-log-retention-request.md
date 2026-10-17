# The 90-day log ceiling on the shared host - what the host owner is asked to set (2026-10-16)

**Status: a request was drafted, NOT SENT.** The detailed inventory of what the host records, the
exact settings requested and the message itself are kept in the operators' private notes. Nothing was
changed on the host by this project: the host is the school IT department's, and no install,
removal or security setting is made there without their written agreement, asked BEFORE
([durable-rules](../durable-rules.md), "The shared host").

## Why

Canari's privacy policy (`frontend/src/routes/legal/privacy/+page.svelte`) promises that technical
logs (IP address and timestamp of HTTP requests) are kept at most 90 days for security, then deleted
automatically. Every request crosses the host's reverse proxy and its security stack before reaching a
Canari container, so client addresses are written in places this repository does not control. What
it DOES control is enforced or reported since 2026-10-16 ([logging](logging.md#the-90-day-ceiling-2026-10-16)).

## What lives where, and who sets it

Host-level logs (the system journal, the reverse proxy's access logs, the intrusion-prevention
agent and its database, file-integrity reports, the endpoint agent, authentication logs, uncapped
co-tenant container logs) belong to the host owner. The project owes its own stores: the identity
provider's event log (retention to be set to 90 days or less by the user), its container logs, and
the logs of the legacy relay.

## When it is done

Once the host owner confirms each bound, re-read each one rather than trusting the answer.
