# A sign-in that returns from the school CAS with no `code` and no `state` (measured 2026-10-06 to 2026-10-22)

Signing in to MiConnect through the school CAS (OIDC source `cas-emse`, see
[authentik](authentik.md)) sometimes fails once and then succeeds: the browser comes back to
`/source/oauth/callback/cas-emse/` **with no query string**, Authentik logs `No state stored in the
session`, restarts the flow by itself, and the second pass works. The person sees a failure followed
by a success, which is why nobody reproduced it by hand for a long time.

## What it is

- **Symptom on our side**: a callback request without `code=` (a *bare callback*) from a browser,
  then a normal callback with `code=` from the same client seconds later.
- **Symptom on the CAS side**: the audit trail shows `SERVICE_TICKET_VALIDATE_SUCCESS` and then **no**
  `SERVICE_ACCESS_ENFORCEMENT_TRIGGERED` for the service. In the successful runs the second event
  follows within ~60 ms.
- **Cause, proven by an A/B on a lab CAS**: the CAS keeps the pending authorization request in a
  cookie of its own (`DISSESSIONOauthOidcServerSupport`, the OAuth session-replication cookie). By
  default that cookie is **pinned to the client's IP address and user-agent at the moment it is
  created** (`pinToSession`). If either differs when the browser comes back from the login page, the
  cookie is refused, the authorization request is dropped, and the CAS redirects to our callback
  without a code.
- **Why it hides**: the CAS logs the *same* warning text for this cookie and for its single-sign-on
  cookie (`TGC`), which is also pinned and stays pinned. The logs alone cannot say which cookie was
  refused; only a controlled change of one variable can.

## The setting

`cas.authn.oauth.session-replication.cookie.pin-to-session=false` on the CAS. The cookie then stays
encrypted and signed but is no longer tied to the address or the user-agent that created it.
Alternatives that keep a pin are `allowed-ip-addresses-pattern` (a range instead of one address) and
`geo-locate-client-session`. The single-sign-on cookie keeps its pin either way, so a stolen session
cookie is still refused from another browser; only the short-lived authorization request is relaxed.

## What was measured

Each row changes ONE variable between the redirect to the CAS and the return, all else equal. A
*control* repeats the run with nothing changed.

| CAS | Variable | Before the change | After the change |
| --- | --- | --- | --- |
| school production, 2026-10-06 | IP only | 8 of 8 fail | not re-measured |
| school production, 2026-10-06 | user-agent only | 15 of 15 fail | not re-measured |
| school production, 2026-10-06 | Wi-Fi to cellular on a phone | 3 of 3 fail | not re-measured |
| school production, 2026-10-06 | controls | more than 80 pass | - |
| lab CAS (Apereo CAS 7.3.8.3, defaults), 2026-10-06 | IP only / user-agent only | 0 of 3 / 0 of 3 | 12 of 12 with `pin-to-session=false` |
| school test CAS, 2026-10-08 then 2026-10-20 | IP only | 0 of 3 | 3 of 3 |
| school test CAS, 2026-10-08 then 2026-10-20 | user-agent only | 0 of 3 | 3 of 3 |
| school test CAS, both dates | controls (same IP, same user-agent) | 3 of 3 | 3 of 3 |

- The school's own setting was applied on its side and **was not seen**; 12 of 12 is what the
  setting `pin-to-session=false` produces, but another setting could produce the same numbers. Ask
  the school which one it applied before quoting it.
- On the test CAS the two addresses were really different at the CAS: the browser left from one
  address and came back from the school host's address.
- A phone on a cellular network is IPv6-only behind a NAT64 on the carriers measured, while the
  school CAS has no IPv6 address, so a phone that moves between Wi-Fi and cellular changes address
  by construction.

## What production shows without anyone touching it

Counting callbacks of browsers in the reverse proxy's access log of the identity provider (2026-09-26
to 2026-10-10, UTC days; the back-channel calls the CAS makes for single logout and the native HTTP
client are excluded, they raise the same Authentik warning and are not sign-ins):

| Period | Callbacks with `code` | Bare callbacks | Share | Never followed by a success from the same client within 10 minutes |
| --- | --- | --- | --- | --- |
| 2026-09-26 to 2026-10-07 20:00 | 988 | 163 | 14 % | 91 |
| 2026-10-08 to 2026-10-10 | 227 | 10 | 4 % | 4 |

Daily share: 11 to 21 % up to 2026-10-07, then 3.5 %, 4 % and 6 %. Clients that failed twice within
30 minutes went from 24 to 2. **The cause of that drop is not established**: the school is reported
to have made a stronger second authentication step mandatory in the same days (reported by the
project owner, not observed here), and the time between the redirect and the callback doubled (about
5-9 s to 13-18 s), which fits a step added for the person; it may also be the cookie setting. Do not attribute it to either without re-running the table above on the
production CAS, which needs one second-factor validation by a person.

## Method, so it can be repeated

- A real Chrome driven over the DevTools protocol, signing in at the CAS login page, with a small
  local proxy whose egress can be switched between the workstation and a school-side host through an
  SSH SOCKS tunnel. Changing the egress between the redirect and the return changes the IP; the
  user-agent override changes the user-agent. Detection: a callback with no `code=` from the same
  client that started the sign-in, counted from the identity provider's own log.
- The scripts were written for one campaign and are **not kept in the repository**; the method above
  is what is needed to rebuild them. A test MiConnect (a copy of production configuration with no
  users) was used so the school's test CAS could be pointed at it; where it runs is in the private
  operations notes.
- **`docker logs` of the identity provider's server container can stop at a NUL byte** written into
  its JSON log file (it did after a restart, hiding 2/3 of the lines). Read the log file itself as
  root with the NUL bytes stripped before concluding a day has no lines.
- Never count a callback whose user-agent is the CAS's own HTTP client: single logout calls our
  callback from the CAS side and raises `No state stored in the session`.

## Closed by the project owner, 2026-10-22

- **No re-measure of the school production CAS.** The school brings its own fix to production when it reaches it
  on its roadmap; nothing is owed here and the table above stays as the record. If the production share of
  bare callbacks (second table) is ever read again, compare it with 14 % before 2026-10-08 and 4 % after.
- Nothing in Canari or in Authentik can fix this: Authentik already restarts the flow, which is why
  the failure heals. The fix belongs at the CAS.
