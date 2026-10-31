# The Lydia API as Canari knows it

The ONE reference for what Lydia's API does, as learned by this project. Lydia's own documentation is
partial and its sandbox moves, so every row below carries WHERE IT COMES FROM. **A row marked
`doc` or `csm` has not been seen to be true; only `measured` has.** Add a fact here when you learn
one, with its source and date - the narrative of how each was found stays in
[payments](frontend/modules/payments.md), which this page does not replace.

Sources: **measured** = observed by this project against the sandbox (`homologation.lydia-app.com`),
date given, or against **production** where the row says so (first run 2026-10-23); **doc** = Lydia's published API documentation, never observed; **csm** = written by
Lydia's customer-success contact in the 2026 exchange, never observed; **inferred** = our reading.

No token, signature or key value appears in this repository, on this page or anywhere: names only.

## 1. The four credentials, and what each is for

| Name | Public? | Scope | What it does |
|---|---|---|---|
| Provider token (public) | no | the whole platform, one pair | `provider_token` on `business/create`, `request/do` and `request/state` |
| Provider private token | no | the whole platform | signs calls that Lydia asks to be signed; **does NOT verify callbacks** (measured 2026-10-15) |
| `vendor_token` | yes | one Business (one association) | names the destination of a payment; `business/create` answers it as `api_token`; stored as `associations.lydiaAccountId` |
| Business private token | no | one Business | **signs that Business's callbacks** (measured 2026-10-16 on the sandbox, and a `confirm` in production 2026-10-23); shown in the Lydia console, "Mes informations", once the Business is validated (csm) |

- `business/create` answers `api_token`, `api_token_id` and `dashboard_url`, and **`api_token_id` IS the
  Business private token** (homologation, 2026-10-30, on a fresh Business): `auth/vendortoken` (`vendor_token`,
  `vendor_id`) answers `{status: "ok"}` with it and error 103, "Le token id ne correspond pas au token", with a
  wrong value (the control); the doc agrees ("api_token_id also known as private vendor token"). This
  contradicts the csm's 2026-10-20 "read it from the console". Proven by `auth/vendortoken` only, NOT yet by
  a callback verifying with it. **Canari captures it at creation** (enrolment lot 1): the onboarding
  sends the pair to `auth/vendortoken`, and only an `ok` links the Business, the key stored encrypted
  exactly as a pasted one; a 103 links nothing ([payments](frontend/modules/payments.md#the-key-is-captured-at-businesscreate-enrolment-lot-1)).
  The paste field of PR #1940 is gone; its route answers a typed 410 to old store builds.
- Lydia can regenerate a Business private token; the old one is invalid at once (csm, 2026-10-20). Nothing
  here regenerates it.
- Lydia asked that the `vendor_token_id` stay strictly private in the backend (csm).
- **Which environment a Provider token belongs to** (measured 2026-10-23): call `business/create` on each
  base URL with the `provider_token` and NO other field. Its own environment answers error 1, "Parametre
  manquant", and creates nothing; the other answers code 104, "Provider inconnu". `request/state` cannot
  tell: it does not check `provider_token` at all.
- **A Business created OUTSIDE the Provider is accepted under it** (measured in production 2026-10-23): an
  association's older Lydia Pro merchant account, created directly with Lydia, used as `vendor_token` with
  our production Provider token, issued a request, took a real payment and sent a `confirm` that verified
  with that Business's own private token. Its console ("Mes informations") shows its production public and
  private tokens; its TEST tokens are not in the console, only obtainable by e-mail to Lydia's support.
  Canari does not use this path: see [the enrolment rule](frontend/modules/payments.md#enrolment-goes-through-canari-and-only-through-it-2026-10-23).

## 2. Calls

Base URLs: sandbox `https://homologation.lydia-app.com`, production `https://lydia-app.com`; every call
is `POST /api/<call>.json`, form-urlencoded. Answers are JSON `{error: "0", ...}` on success; a rejected
`business/create` answers `{status: "error", code, message}` instead (measured).

### `request/do` - ask a payer for money

Fields Canari sends: `amount` (decimal string, two digits), `currency`, `type` (`email` or `phone`),
`recipient`, `message`, `vendor_token`, `provider_token`, `order_ref`, `confirm_url`, `cancel_url`,
`expire_url`, optionally `expire_time`, `browser_success_url`, `browser_fail_url`, `end_mobile_url`.
`request/do` takes **no signature** (doc: reserved to another Lydia product).

Answer (measured 2026-10-15): `{error, request_id, request_uuid, message, mobile_url, order_ref}` -
the numeric `request_id` (what callbacks carry) AND the `request_uuid` (**32 hex digits, no dashes**), plus
`order_ref` echoed. `mobile_url` is the payer page `.../collect/payment/<request_uuid>/auto`.

- **Amount range: 0.50 to 1000.00 EUR** (csm, 2026-10-04); Canari refuses outside it before calling.
- **`order_ref` must be UNIQUE per request**: a second `request/do` with an `order_ref` already used
  answers error 3, "order_ref deja utilise" (measured 2026-10-21). Canari's boutique reused one string per
  product and user, so a declined purchase could never be retried; it names the attempt since migration
  101. A paid FORM had the same defect - a retry reuses the pending row, and every request of it carried
  `form:<submissionId>` - and sends `form:<submissionId>:<8 hex digits>` (50 characters) since 2026-10-27
  ([payments](frontend/modules/payments.md#a-form-answer-sends-one-order_ref-per-request-2026-10-27)).
- **`order_ref` has NO documented maximum length**: the apiDoc (`POST /api/request/do`, field `order_ref`)
  says only "used to identify a remote request, must be unique". Measured accepted: 109 characters on the
  sandbox (2026-10-21, the pre-101 boutique form) and the 41-character `form:<uuid>`. No production log
  retains an accepted order_ref's length (core logs live as long as the container). Canari keeps every
  order_ref inside the measured 109 with a margin: forms 50 (pinned by a test), products 81.
- **A Business that is not validated answers error 5 BEFORE any order_ref check** (sandbox, 2026-10-27): a
  Business fresh from `business/create` answered error 5 to the first `request/do` AND to a second carrying
  the same order_ref, never error 3. So error 3 can only be re-measured with a validated sandbox Business;
  the dev association that had one lost its link at a dev data reset.
- **`expire_time` is an integer number of SECONDS from creation** (measured 2026-10-15): `60` expired after
  about 79 s, `120` after about 181 s (a sweep of roughly one minute); absent and `0` never expired in the
  window watched (`0` is NOT "expire now"); no ceiling refused (one year accepted); `abc`, `-5` or a date
  string answer error 1, "Format de la date d'expiration incorrect". The default lifetime is **unknown**; a
  sandbox request sent with no `expire_time` was still open (`state 0`) 47 minutes after its creation
  (measured 2026-10-23), so it is at least that.
- Error **5**, "Ce lieu d'activite est temporairement bloque", means the Business is not validated
  (measured again in production 2026-10-23, on a Business `business/create` had just made): nothing
  in the product probes it yet, and a global admin marks an association validated by hand
  (`complete-lydia-account`) once Lydia has validated the documents (24 to 48 hours, csm).

### `request/state` - read a request

Works with `request_uuid` alone (measured). `vendor_token` is optional and only adds a `signature` to the
answer; `request_id + vendor_token` and `order_ref + vendor_token` also find the request (measured
2026-10-15); an unknown id answers error 2, "Requete introuvable".
Answer: `{state, used_ease_of_payment[, signature]}` - **no amount, no expiry date, never `order_ref`**
(so the answer cannot say which Canari row it is about: the caller must already know).

**The `signature`** (doc, read 2026-10-27; **the composition is not measured**): MD5, built like every
Lydia signature (pairs sorted by key, `&`, then `&` and the key), over **`amount`** and **the id the call
named** (`request_id`, `request_uuid` or `order_ref`), with the **Business private token**. So
`md5("amount=<amount>&request_uuid=<uuid>&<key>")` for a read by uuid. Two consequences:

- The answer carries no amount, so the signature can only be recomputed over the amount the CALLER
  expects - which makes one comparison prove both the origin and the amount the request was issued for.
  Canari writes the amount exactly as `request/do` sent it (`"12.50"`, `lydiaAmountString`); whether
  Lydia signs that same string, or `"12.5"`, is the unmeasured part, and a wrong guess fails closed.
- **The `state` is not in the signed set.** The signature proves which request and which amount the
  answer is about, not what it says about them: the state still rests on the TLS read from Lydia's host.

Canari verifies it only where it asks to (`payments/request-state` with `expectedAmountCents`, used by the
reconciliation sweep, [section 7](#7-reconciliation---the-sweep-lydias-documentation-asks-for)); the payer's
return and the callback's read do not verify it yet.

| `state` | Meaning | Source |
|---|---|---|
| `0` | open, waiting for the payer | measured 2026-10-15 |
| `1` | **paid** | measured 2026-10-21 (an authorised payment on the sandbox page) |
| `5` | **declined** by the payer | measured 2026-10-21 |
| `6` | cancelled or expired - merchant cancel, payer's own cancel link and expiry all leave `6` | measured 2026-10-15 |

`state` alone cannot tell expired from cancelled; a callback's `outcome` (the query parameter Canari adds)
can. No other state has been seen; an unknown value must be treated as NOT paid and NOT settled.

### `request/cancel` - the merchant cancels

Fields: `request_id` (the NUMERIC id) + `vendor_token`, no signature. Answer `error: "0"`, then `state 6` and
the `cancel_url` callback fires (measured 2026-10-15 and 2026-10-21). Variants that fail (measured): sending
`request_uuid` or `identifier` -> error 1, "Parametre manquant"; `request_id` without `vendor_token` or with
`provider_token` instead -> error 105, "Operation not allowed."; a request already cancelled or expired ->
error 2, "Cette transaction a deja ete traitee". **A PAID request answers the same error 2 and stays `state 1`**
(measured on the sandbox 2026-10-23): a cancel never undoes a payment, and error 2 alone cannot say whether
the request was paid or closed - read the state after it, which is what Canari does.

### `business/create` - create an association's Business

Needs the legal profile of the association and the Provider token. Answers `api_token` (the
`vendor_token`), `api_token_id` (see section 1) and `dashboard_url`, **once**: the dashboard link is not
re-issuable (measured). An unknown `provider_token` answers `{status: "error", code: 104}`. Re-running the
onboarding would replace the linked Business silently, so **Canari refuses it** while one is linked: a typed
409 `LYDIA_ACCOUNT_ALREADY_LINKED`, before any call to Lydia (enrolment lot 1; unlinking stays the
confirmed "disconnect").

Fields Canari sends: `provider_token`, `name`, `address`, `zipcode`, `city`, `country`, `business_email`,
`business_phone`, each as typed in the onboarding form (`country` is the word typed, e.g. "France", not an
ISO code), and since enrolment lot 1 `webhook` (`<public origin>/api/payments/lydia-business-webhook`;
**not yet observed** being called by Lydia). **That these seven SUFFICE is measured** (three creations accepted in production 2026-10-23;
`provider_token` alone answers error 1). **That they are the WHOLE list is not**: it was taken from Lydia's
API documentation during the 2026-09 migration plan, which is not kept in this repository, and no optional
field was ever tried (the plan names an optional `webhook`). **Lydia's documentation (section 5b, read
2026-10-27) lists exactly these seven plus `send_email` and `webhook`, and NO field names a holder**: a person is attached by `business/addcashier`, `auth/register` or `auth/login`. In production (measured 2026-10-23) the answer also carries `merchant_ident`, EMPTY while
the Business is not validated, and `dashboard_url` is `.../console-pro/<business id>-<slug>`. That link
answers **404 to anyone not signed in to the Lydia console**, on the sandbox and in production alike: it is
not a sign-in link, and the console path is the one below.

### Activating a Business that `business/create` made (production, 2026-10-23)

Lydia e-mails the `business_email` a "Confirmation de votre compte Lydia Pro" right after the call. It
names three steps (quoted from that e-mail, not yet walked through end to end):

1. **Connexion flash**: open the Lydia console (`services.lydia-app.com/consolepro`) and scan the QR code it
   shows with the **Lydia Pro** mobile app.
2. **Documents**: upload the supporting documents in the console's "Documents justificatifs" tab (the
   e-mail's example is a KBIS or SIRET extract).
3. **Validation** by Lydia, after which the Business can take payments (error 5 until then).

**What blocked, measured:** the Lydia Pro app signs in with a PHONE NUMBER. Signed in with a number that
already held another Business, the console listed only that older Business, and nothing reached the new
one. A second Business, created the same day through Canari's onboarding with the e-mail and phone of the
person then signed in to the app, did not appear in that console either. So `business_phone` alone does not
attach a Business to a Lydia Pro identity (measured 2026-10-23).

**The missing step, measured in production 2026-10-30:** a person added by the Provider-signed
`business/addcashier` (all rights, `notify=yes`) receives Lydia's SMS and, signed in to the Lydia Pro app
with that number, sees the Business. So the holder of a Business made by the Provider reaches it through
`business/addcashier` (section 5b), not through `business_phone`.

### Refunds and listings - documented, never called

`transaction/cancel`, `transaction/refund`, `transaction/list` exist (doc). Refunding a transaction needs the
equivalent sum to have been sent to Lydia's company beforehand; each Business has an authorised overdraft
of 100 EUR which allows a few refunds if the tariff permits (csm, 2026-10-20). Whether `transaction/list`
aggregates is **unconfirmed**. No Canari code calls any of the three.

## 3. Callbacks (`confirm_url`, `cancel_url`, `expire_url`)

Lydia POSTs to the URL given on the request; Canari appends `?outcome=confirm|cancel|expire` so the route
knows which one it is (Lydia does not say).

- **Body: `multipart/form-data`** (measured 2026-10-15). A parser that reads only JSON and urlencoded sees
  an empty body.
- **Fields (measured 2026-10-16 and 2026-10-21)**: `cancel` and `expire` carry 7: `currency`, `request_id`,
  `amount`, `signed`, `vendor_token`, `order_ref`, `sig`. `confirm` carries 8: the same plus
  `transaction_identifier`. `signed` is a field of the callback, not a flag of ours.
- **Signature: the BUSINESS private token, over EVERY received field except `sig`, `MD5` of the
  `key=value` pairs sorted by key, joined by `&`, followed by `&` and the key** (measured 2026-10-16:
  `cancel` and `expire` verified this way on the sandbox; a `confirm`, with its `transaction_identifier`,
  verified the same way IN PRODUCTION on 2026-10-23, by Canari's own route with the key a manager had
  pasted). A field set that leaves `signed` out does not verify. **The values are signed RAW**: every one
  of those callbacks carried an `order_ref` with `:`, which a URL-encoded signature would have written
  `%3A` - the opposite of what Lydia checks on a request Canari SENDS (section 5b, 2026-10-30).
- A decline sends **no callback** at all (measured 2026-10-21); a payer's "annuler" link and a merchant
  cancel send `cancel`; expiry sends `expire` (a single POST in the window watched). Whether a non-2xx is
  retried is **unknown**.
- Which Lydia address calls is not recorded here; the route is public and rate-limited, and a verified
  callback is only a TRIGGER for a read of the row's own request ([payments](frontend/modules/payments.md)).

## 4. Where the payer goes back

- **`browser_success_url` / `browser_fail_url`** are used as sent. On success Lydia appends
  **`transaction=<32 hex, upper case>`** with `&` after our own query string (measured 2026-10-21), and
  leaves ours intact. It does NOT replace a `{CHECKOUT_SESSION_ID}`-style placeholder (measured 2026-10-05),
  so Canari puts its own `submission_id` in the URL.
- A **decline** ends on Lydia's own page `/collect/payment-error?code=28&uuid=...` with no link back and no
  redirect (measured 2026-10-21); an **expiry** shows the same page with `code=27`.
- A card refused at 3-D Secure ends on `payment-error?code=4` and the request stays `state 0` (measured
  2026-10-15, before Lydia's sandbox update).
- `end_mobile_url`: a deep link should be accepted (csm, 2026-10-20); **Canari has not tested one**.

## 5. The sandbox

- The payer page offers **Authorize, Decline and Expire** (measured 2026-10-21): choose the final status
  there, no test card needed since Lydia's update of 2026-10-21 (csm). The buttons that set a status by hand
  were removed for a while and re-published; they are not guaranteed to stay.
- A real card is refused at the 3-D Secure step in the sandbox; never type one.
- Requests created on the sandbox expire by themselves; an open one is harmless.
- The sandbox and production answer the same shapes as far as measured. Production was first run on
  2026-10-23: one real payment of the minimum amount, its `confirm` verified (sections 1 and 3).

## 5b. What Lydia's own documentation says (read 2026-10-27)

The API documentation is an apiDoc site served by the sandbox itself (`https://homologation.lydia-app.com/doc/api/`, its data in `api_data.json` and `api_project.json` next to the page), open to anyone. Lydia's account manager said our open questions were answered there. **It is the primary source for everything below; it is not copied into this repository, read it at that address.** What it settles:

- **Signature (all signed calls and callbacks):** the MD5 of the `key=value` pairs sorted alphabetically, joined by `&`, followed by `&` and the private token. Parameters are signed AS SENT: if a layer escapes them, they are signed escaped. **What that means in each direction was measured, and the two differ:**
  - **A request Canari sends (homologation, 2026-10-30, authorised by Lydia):** Lydia checks the signature against the URL-ENCODED keys and values, as PHP `urlencode`/`http_build_query` write them (RFC 1738: a space becomes `+`, every byte outside `[A-Za-z0-9_.-]` becomes `%XX` in upper case), i.e. `md5(sorted urlencode(key)=urlencode(value) joined by & + & + private token)`. `business/addcashier` signed over the RAW values answered `444` every time; signed over the encoded values it passed; the same request with a deliberately wrong signature answered `444` (the control). The doc only hints at it ("the loop can be replaced by `http_build_query`").
  - **A callback Lydia sends (section 3):** signed over the RAW values. Every Canari `order_ref` carries `:` (`form:...`, `product:...`), and the callbacks of 2026-10-16 and the production `confirm` of 2026-10-23 verified over the raw string. So `signLydiaParams` (core-service) stays RAW: it serves only the verification of what Lydia signs, and encoding it would refuse every callback. No Canari code signs an outgoing request yet; the one that does must encode first.
- **`request/do` cannot be signed:** the doc says the `signed` field of a callback is "0 most of the time" because a call to `request/do` is not signable (a signature is reserved to another Lydia product).
- **Reconciliation and the `request/state` signature:** the doc names three ways to learn a request was paid (callback, `request/state`, `transaction/list`, at least two of them) and advises checking the `request/state` signature; both are implemented, see section 2 and [section 7](#7-reconciliation---the-sweep-lydias-documentation-asks-for).
- **`business/create`:** the documented parameters are `provider_token`, `name`, `address`, `zipcode`, `city`, `country`, `business_email`, `business_phone`, `send_email` (`yes` by default) and `webhook`. The doc lists `webhook` without marking it optional; production accepted our seven without it. The webhook receives two POST fields only, `vendor_token` and `event`, **unsigned**, with the events `BUSINESS_VALIDATED` and `BUSINESS_UNVALIDATED` (the second turns daily bank transfers off). Unsigned means it is a hint, never a proof: a safe use re-reads the Business's state from Lydia before trusting it. **No call reads that state** (the one measured signal, error 5, comes from a real `request/do`), so Canari's route writes nothing: it logs the event and the association holding the token, and a global admin still validates by hand ([payments](frontend/modules/payments.md#the-key-is-captured-at-businesscreate-enrolment-lot-1)).
- **Who holds a Business made by the Provider:** none of the creation parameters names a holder. The doc gives three ways to attach a person: (1) `business/addcashier` with `provider_token`, `vendor_token`, `cashier_phone` (a mobile number), `permissions` (the doc says a JSON object; **measured on homologation 2026-10-30, it must be a JSON-encoded ARRAY OF NAMES**, e.g. `["access_collect","access_cashier"]` - an object `{"access_collect":1,...}` gets a generic HTTP 500 HTML page with no error code, the array gets `error: 0` and `business/getpermission` then lists the rights granted; the names are `access_collect`, `access_allreceipt`, `access_checkout`, `access_statement`, `access_feedback`, `access_cashier`, `access_voucher`, `access_marketing`, `access_fee`, `access_cancelrequest`, `access_canceltransaction`, `access_manage_collects`, `access_easeofpayment`) and a `signature` over `cashier_phone` and `permissions` plus the Provider private token; `notify=no` skips the text message; the cashier "will next need to register" and `access_cashier` is the right that manages cashiers; (2) `auth/register` with the `vendor_token`: creates a pro account attached to the Business (which rights it gets is an operations matter, in the private operations notes); (3) `auth/login` with a `vendor_token`: links an existing account to the Business with the right to collect. This explains the measured 2026-10-23 failure (a phone alone attaches nothing) and makes `business/addcashier` the missing enrolment step. **Tried by Canari on 2026-10-27 and 2026-10-28, outcomes only:** `business/addcashier`, signed with the Provider private token as documented, answered `444` on the sandbox and on a production Business; `auth/create_account`, signed the same way, answered a signature error; `business/create` works unsigned; `auth/register` with the `vendor_token` is the route that attaches a person on the sandbox; `auth/login` on a production Business answered an HTTP 500 and linked nothing. The Lydia contact confirmed the key is "normally" the Provider's and could not answer on the string to sign. **Settled on homologation 2026-10-30:** the `444` was the RAW signature - the key was right, the string was not (see the signature bullet above); with the encoded string and `permissions` as an array of names, `business/addcashier` answers `error: 0`. `auth/create_account`'s signature error is most likely the same cause (its signed e-mail carries `@`), not re-tried yet. **The cashier calls (homologation, 2026-10-30, encoded signatures):** `business/addcashier` grants exactly the rights listed, and calling it again on the same phone REPLACES them (re-adding `["access_collect"]` leaves collect alone); an empty list `[]` answers error 3, "Format des permissions invalide". `business/getpermission` reads a cashier's rights, each `access_*` as `"0"` or `"1"`. **Removing a cashier works** (homologation, 2026-10-30): Lydia's cashier-removal call answers `error: 0` and `business/getpermission` then reads every right of the removed cashier as `0`; the call shape is in the private operations notes. Every call needs the `.json` suffix (section 2); without it the answer is XML. The rights a registration gives are an operations matter, kept out of this public page.
- **`auth/vendortoken`** validates that a public vendor token and a private one match (`vendor_token`, `vendor_id`): the check an admin's pasted private key never had.
- **Errors worth a typed answer:** `104` unknown Provider (also an unknown recipient), `102` invalid vendor token, `103` tokens do not match, `10` not authorised, `3` bad permission format or an `order_ref` already used, `444` invalid signature, `2701` blocked business, `5` no provider for a remote request (the documented name of the error a not-yet-validated Business gets on `request/do`), `106` user already exists, `198` missing information.
- **The sandbox's own tools:** a developer back office at `https://homologation.lydia-app.com/backoffice` (sign in with the vendor token) to look at transactions and requests and simulate payments; two fake card numbers are listed there too, but section 5 measured that a real card flow is not the way in the sandbox since Lydia's update.
- **Not in the doc:** which documents an association must give for validation, the console sign-in of a Provider-made Business (the three ways above are the only documented route), the format expected for `country`, and refund prerequisites.

## 6. Still unknown

- The exact `request/state` signature: whether the amount is signed as sent (`"12.50"`) or normalised
  (section 2), and for an `order_ref` lookup whether its `:` is signed raw, like a callback, or
  URL-encoded, like a request (section 5b). **Settled by the first reconciliation of a real request**: a `verified` line, or a
  `does NOT verify` ERROR on a row whose amount is right.

- The default lifetime of a request with no `expire_time` (at least 47 minutes on the sandbox).
- Whether a callback verifies with `api_token_id` (section 1 proved it the private token by
  `auth/vendortoken` only, 2026-10-30).
- Whether `auth/create_account` passes once signed over the URL-encoded values (section 5b settled
  `business/addcashier` on 2026-10-30; create_account was not re-tried). Whether `auth/register` makes a Business made by `business/create` appear in a
  person's console on production is not tried there, and which documents Lydia asks of an ASSOCIATION
  (the e-mail names a KBIS or SIRET extract).
- What a refund does end to end.
- Whether a callback is retried after a non-2xx, and from which addresses Lydia calls.
- Whether `expire_time` has a ceiling.
- Whether Lydia accepts the app's deep link as `end_mobile_url` and appends anything to it.

## 7. Reconciliation - the sweep Lydia's documentation asks for

Lydia's documentation asks a merchant to reconcile through at least two of: the callback, `request/state`
and `transaction/list` - and, for every request whose callback has not arrived, to call `request/state`.
Canari had the callback and two `request/state` readers that both need a person (the payer's return, and
a retry). A payment whose `confirm` was lost and whose payer closed the tab was recorded by nothing. **The
sweep** (`LydiaReconciliationService`, social-service, since 2026-10-27) is the missing reader:

- **What it reads, and when.** A form answer still `pending` whose request has ENDED (`paymentRequestedAt`
  past the hold cutoff, the hold = the request's `expire_time` + Lydia's measured expiry margin), and a
  boutique attempt still `open` past `expiresAt` + `CHECKOUT_EXPIRY_MARGIN_MS`. The threshold is the
  request's own lifetime, not a chosen clock: past it the request cannot change, so ONE answer is final.
  The form half runs in the 5-minute expiry tick, **before** the expiry, and both select by ONE cutoff read
  from the database clock at the start of the tick (`FormsService.pendingHoldCutoff`): with a clock each, a
  row whose hold ended between the read's SELECT and the expiry's UPDATE was expired unread. It stops
  starting reads after 60 s (`FORM_SWEEP_BUDGET_MS`), so the expiry waits at most that plus one read; what it
  did not reach is expired unread, at ERROR. The boutique half runs on its own 5-minute cron, OLDEST first.
  At most 50 rows per kind per tick.
- **An answer is acted on once; no answer is retried.**
  - A form answer is read once: what the read did not settle is expired by the expiry that follows.
  - A boutique attempt leaves `open` as soon as its read gave a FINAL answer: settled or released from a
    verified state; a verified `open` past its end is **cancelled at Lydia first**
    (`ProductsService.cancelStillOpenCheckout`, the cancel the buyer's next attempt makes - a request left
    payable after Canari closed it is a double charge), then closed; a cancel answering "already processed"
    is read once more at once, and still `open` then is closed; a mismatch, `unsigned`, no usable key (a key
    that does not open answers `no-key`), an unknown state, and a refusal whose Lydia code is MEASURED final
    close it `expired` (`ProductsService.expireUnprovenCheckout`, logged at ERROR).
  - **Closing is not free.** Nothing reads a closed attempt again: if its request was in fact PAID and its
    confirm callback was lost, nothing records the payment (the payer's return asks only of an open
    attempt). A callback that DOES arrive still records over an expired attempt (`settlePaidCheckout`,
    at ERROR, asserted by the integration spec) - that is the one path left, not a guarantee.
  - **A refusal closes only from an ALLOWLIST** (`LYDIA_REFUSALS_FINAL`,
    `apps/social-service/src/common/core-payment-error.ts`), because a refusal can be a state of Lydia (a
    Business temporarily blocked, a revoked provider token) as much as a word about the request. **Both
    lists are EMPTY.** Read: error `2` ("Requete introuvable") was measured on a uuid Lydia NEVER issued
    (2026-10-15); the sweep reads uuids Lydia DID issue, and what error 2 means for one issued then purged,
    archived or moved between environments is unmeasured - a PAID request answered that way would be closed
    for good. Cancel: no refusal is measured final, so after a refused cancel the attempt stays open and the
    request stays PAYABLE at Lydia until it expires; the next tick reads it again, and a later callback
    records over the attempt as above. Every refusal is therefore retried and accused. The mechanism and its
    tests stay (a test subclass overrides the services' readonly `refusalsFinal`).
  - **Core answers about ITSELF with a 503, never a 400.** On `request-state` and `cancel-request` the only
    400 is Lydia's typed `PAYMENT_PROVIDER_REFUSED`; payments switched off, Lydia not configured and a
    payload core will not read answer `503 PAYMENT_SERVICE_NOT_READY` (`PaymentController.aboutTheRequest`).
    The read and the cancel go through ONE classifier (`classifyCoreCallFailure`): `refused` (closes only if
    allowlisted), `core-fault` (401/403, the 503 above, any other 4xx), `no-answer` (no response, 408, 429,
    other 5xx).
  - Everything else leaves the attempt `open`, read again next tick: no answer, a core fault, a refusal not
    known final, a verdict social-service does not know (an older core mid-deploy), a cancel that did not go
    through, and a settlement WRITE that failed after a verified read - above all a verified PAID, whose only
    automatic path this is and which is never closed. Each tick says so in ONE line per cause, never one per
    row: a WARN with the count of calls that got no answer; an ERROR with the failed writes that names every
    attempt and which ones Lydia said PAID; and an ERROR that ACCUSES every attempt left open on a core fault
    or a refusal not known final, each with its cause (the first 20 named, the rest counted) - written when
    that list (ids or causes) CHANGES, not every tick, with a log-level line once it empties; its size is
    its own field of the hourly line, since core faults count as `unavailable` there. The per-row "still
    OPEN at Lydia" WARN is likewise said once while it lasts (once per tick too, across the re-read after
    "already processed"), and the "more than 50 due" WARN when the backlog starts, a log line when it ends.
  - **Fairness, and what this does not bound.** While such a cause lasts (an outage, a revoked token, a
    refusal code nobody has measured) its attempts are re-read every tick. When more than 50 are due, the
    ones accused on the previous tick go LAST, so newer attempts are reached; this lives in process memory,
    which is enough for fairness and reporting (never idempotence): a restart forgets it and costs one line.
    It is still the starvation trade for every unmeasured refusal code, taken knowingly. A bound on retries
    needs durable state (a column, so a migration and the user's decision): deliberately not built.
- **What it does with the answer.** Only a `verified` answer is acted on: `paid` through the ONE writer
  of each kind (`FormsService.markPaid`; `ProductsService.applyRequestState` -> `settlePaidCheckout`),
  `declined` and `cancelled-or-expired` through the release the payer's return uses. A `mismatch` is
  logged at ERROR and settles nothing. A Business with no stored key is not read at all: a form answer is
  then expired as before, a boutique attempt stays `open` (counted in the hourly line) for its buyer's next
  attempt or its callback. The one unsigned answer acted on is a boutique attempt read by its order_ref that
  Lydia does not hold (error 2, core's verdict `unsigned` - an unknown verdict is not one): no request
  exists, no money moved, it is closed `cancelled` as the return closes it.
- **Why it cannot double-record.** Every write goes through a settle path that locks the row and moves it
  out of the status the sweep selects on; the sweep races the callback and the return on the same locks.
  Measured on a real PostgreSQL (`lydia-reconciliation.integration.spec.ts`): the sweep and seven returns
  settling one payment write ONE purchase record, for a form and for an attempt; with the attempt's row
  lock removed, the boutique case wrote more than one. Two replicas sweeping in one tick (a deploy's
  overlap) take the same locks, so the same argument covers them - but what was MEASURED is one sweep
  against seven returns, not two sweeps.
- **The switch: OFF in production until the amount format is measured** (decided 2026-10-27).
  `LYDIA_RECONCILE_ENABLED`, social-service, COMPUTED by `render-env.sh`
  (`compute_lydia_reconcile_enabled`), as `LIVE_ENABLED` was until 2026-10-30: `true` on dev, `false` on production, `true`
  on a local estate. Anything but exactly `true` is OFF: no row is selected, Lydia is not called, and the
  only trace is ONE startup line (`[RECONCILE] Lydia reconciliation sweep OFF ...`); the hourly line is
  not written. Production is turned on by a commit changing that function, after the measurement below.
- **What is owed before production is switched on** (the user's, one-off; the probe command is in the
  pull request that built the sweep, #2595):
  1. On a VALIDATED sandbox Business: which amount string the `request/state` `signature` is computed
     over (`0.50`, `0.5`, `50`, `0,50`), read by `request_uuid` AND by `order_ref`, and on a PAID and on a
     CANCELLED request. The probe runs inside the dev core container (it holds the sandbox Provider
     token); the Business key and vendor token come from a `chmod 600` file on the host, never from the
     command line. Anything but `0.50` everywhere: fix `lydiaStateSignedFields` first.
  2. One full dev sweep read in its logs (a `verified` line per row, the hourly line), then one clean day
     of dev logs: no `does NOT verify`, no `still unproven` close that a callback later contradicts.
  3. A READ-ONLY count on production of what the first tick will read and then close:
     `SELECT count(*), min("expiresAt") FROM product_checkouts c WHERE c.status = 'open' AND
     c."expiresAt" <= now() - interval '5 minutes' AND EXISTS (SELECT 1 FROM associations a WHERE
     a."lydiaAccountId" = c."vendorToken" AND a."lydiaBusinessKeyCiphertext" IS NOT NULL)`. Every one of
     them is read, oldest first, 50 per tick, and settled, cancelled at Lydia or closed `expired` on its answer.
  4. On the sandbox: which Lydia refusal codes are PERMANENT, for `request/state` and for `request/cancel`,
     on a request Lydia ISSUED - above all error `2` on an issued-then-expired uuid (measured only on a
     never-issued one), then a Business blocked then unblocked, a revoked then restored token, a uuid under
     another vendor token. Only a code measured final joins its allowlist; until then such rows are retried
     every tick.
- **What it reports.** One line per row it reads, and once an hour
  `[RECONCILE] last hour - forms: examined= settled= released= unchanged= skipped-unverified= refused=
  unavailable= errors=; boutique: ...; boutique attempts left open on an answer not final: M; ended
  boutique attempts left open with no Business key: N`, even when all zero.

**Not covered, known:** a form answer the expiry moved to `expired` before any read (a backlog over 50 in
one tick, logged at ERROR; Lydia unreachable in that tick; no key) - its payment is still recorded by its
callback or its payer's return, which read `expired` rows. A form keeps no snapshot of the Business its
request went to, so a form whose association re-linked another Business meanwhile is read with the new one
and does not verify (ERROR). `transaction/list` is not used.

## See also

- [payments](frontend/modules/payments.md) - how Canari uses these calls, with the dated measurements.
- [forms](frontend/modules/forms.md) - a paid form's seat hold and the payer's return.
- [backlog](backlog.md) - the defects found on the way.
