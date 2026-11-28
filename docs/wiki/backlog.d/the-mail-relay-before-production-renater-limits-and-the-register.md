## The mail relay before it goes on: RENATER's per-IP limits, the egress exemption, D2 on the new host, the register line (lead, 2026-11-28)

target: 1.10.0

**What this entry gates.** `MAIL_RELAY_ENABLED` on chat-gateway ([mail-client](../mail-client.md) D5,
D12; [the relay](../mail-client-transport.md#the-relay)). Off by default; nothing below is owed while
it stays off. Found by the adversarial review of lot 1 (F0-2, F0-4, F1-1, F1-10).

**Why.** Every relay connection to `partage.emse.fr` leaves from ONE egress address, and RENATER sees
every student who reads their mail on the web behind it. Its brute-force and rate protections are
per address: one account's loop, or simply the whole school at 8 a.m., could get that address
throttled or blocked, and the mail of everyone with it. The relay now caps each account (20 new
connections per minute, 512 MiB per rolling hour, 4 held; `mail_relay.rs`, typed close 4006, every
line naming the account by the first 8 characters of its id), which bounds ONE account. What the
address as a whole may do is RENATER's to say.

### Before `MAIL_RELAY_ENABLED` goes on in PRODUCTION

1. **RENATER's per-IP limits, measured or stated** (connections, failed `AuthRequest`s, requests per
   minute towards Partage), and **the production egress address exempted** from them, or the limits
   written here with the relay's caps checked against them. **An owner action**: it is a request to
   RENATER (or through the school's IT, who hold the Partage contract), which only the owner can
   make. The lead files nothing towards them.
2. **D2 re-measured on the migration target host** ([estate-migration](../infrastructure/estate-migration.md)):
   the 443-only egress to `partage.emse.fr` was measured on the CURRENT production host (2026-11-27).
   The estate moves; a bare TCP connect to `partage.emse.fr:443` (and 993, 465, 587, for the record)
   from the new host, read-only, before the relay is switched on there. If 443 is closed there, the
   relay cannot serve production from that host, and the design is revisited before anything else.
3. **The egress address to exempt is the migration target's** if the move happens first: item 1 is
   asked for the address the relay will actually leave from.

### Before `MAIL_RELAY_ENABLED` goes on on DEV

- **The register declares the relay's connection log, in the SAME pull request that flips the switch
  on dev** ([register](../compliance/register-of-processing.md)): one line per relay connection end,
  with the account's id prefix, the duration, the byte counts each way and the TLS record counts
  (never content), kept as chat-gateway's logs are (C13). The privacy policy says the same, as its
  public face. Lot 3 (#4211) carries the privacy-policy wording; the register line goes with the flip.

### Already true, for the record

- **The school address leaves the device at sign-out**: removed from the device's OIDC store by every
  sign-out that ends the session, as the privacy policy says ("jusqu'à votre déconnexion")
  ([eligibility](../mail-client-transport.md#eligibility)).
