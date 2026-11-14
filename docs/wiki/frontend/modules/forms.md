# Forms module

**Routes**: `src/routes/forms/[id]/` (fill), `src/routes/f/[id]/` (a public form, answered without an account), `src/routes/forms/create/` + `src/routes/forms/[id]/edit/` (admin)
**Components**: `src/lib/components/forms/` (the fill page: `FormQuestion`, `FormHeader`)
**Shared logic**: `src/lib/forms/` (`fillAnswers.ts`, `cotisationSettings.ts`, `itemsPayload.ts`, `questionTypes.ts`)

**What forms cannot do yet, and the decided priced grid**: [forms capability audit, 2026-11-06](../../forms-capability-audit-2026-11-06.md).

## Responsibilities

- Render dynamic association forms for member submissions.
- Support optional online payments (Lydia) or cash payments.
- Display submission confirmation and payment status.
- Let a form manager build and configure a form, including its price grid and the cotisation a
  paid submission grants.

## Form submission flow

```
/forms/:id
  -> GET /api/forms/:id (form definition: fields, basePrice, allowCashPayment)
  -> GET /api/forms/:id/check           (returns `memberPricing`, computed SERVER-side)
  -> User fills form
  -> POST /api/forms/:id/submit { answers, paymentMethod }

If basePrice > 0 and online payment:
  -> social-service: POST /api/payments/create-checkout-session (core, internal)
  -> Redirect to Lydia's payer page
  -> Lydia's confirm callback, verified with the ASSOCIATION'S Business key, triggers a read of the
     row's own request at Lydia (core webhook -> social provider-confirm; payee checked first)
  -> On return (/forms/success?submission_id=...):
       POST /api/forms/submissions/:id/confirm-payment
       (reads the row's own request at Lydia; records it if paid and still pending)
  -> On leaving (/forms/cancel?submission_id=...):
       POST /api/forms/submissions/:id/cancel

If cash payment:
  -> Submit marked as "pending cash"
  -> Association admin validates/cancels via EditFormsTab
```

## The server validates the item model, not only the frontend

A form or booking space is written through `FormItemDto` (`apps/social-service/src/forms/dto/form.dto.ts`, reused by `space.dto.ts`). Two write-side bounds live there:

- **The question type must be one of `SUPPORTED_QUESTION_TYPES`** (`forms/dto/question-types.ts`) - the backend mirror of the canonical `QUESTION_TYPES` in `src/lib/forms/questionTypes.ts`. An unlisted type (the dev-only junk `text`/`select` a hand-posted call once sent) is now rejected with a 400. The `single` alias is read by `FormQuestion.svelte` for old rows but never written, so it is deliberately absent from the write allowlist. The two lists cannot share a module across the package boundary, so a drift test (`forms/dto/form.dto.spec.ts`) reads the frontend source and fails when they differ.
- **`basePrice` and an option's `priceModifier` are integer CENTS** (`@IsInt`), so a fractional cent is rejected; the client sends `Math.round(euros * 100)` and the service passes a `priceModifier` straight to Stripe as a `unit_amount`. **`priceModifier` is also `@Min(0)`**: `calculateModifiers` ignores a value <= 0, so a negative one would show the payer a discount the charge never applies - the builder number inputs now carry `min="0"` too.

## The fill page is three reusable pieces and its own payment logic (2026-09-30)

`routes/forms/[id]/+page.svelte` was ~1300 lines holding everything; what any page filling a form
needs is now outside it, so a second fill page (a form opened without an account) reuses rather
than copies it:

| Piece | What it owns |
|---|---|
| `forms/fillAnswers.ts` | The empty selection per type, "is this answered", the first required question left empty (and its sentence), which questions an answer reveals, the answers actually sent (the ANSWERED ones only), the amount formatter |
| `forms/answerBounds.ts` | The bounds of an answer (`libs/contracts/form-answers.json`), the sentence for each coded refusal of a submit or a save, and the editor's grid-label check - see [answers, grids and refusals](#answers-grids-and-the-codes-a-submit-is-refused-with-2026-11-06) |
| `forms/FormQuestion.svelte` | One question card: label, help, image, and the input its type calls for, bound to the answer. Pricing arrives as two callbacks (`optionModifier`, `optionClosed`), because only the page holds the grid slice |
| `forms/FormHeader.svelte` | Title, banner, the price badge (once, for both layouts), description, the anonymity notice |

What stays in the page is what only a signed-in submission has: the pricing slice, cash, the
reminder, and the sticky submit bar.

**One defect closed by the extraction**: validation said `!val` where the progress bar said
`val !== ''`, so a required linear scale starting at 0 counted as answered on the bar and was
refused by the button. `isItemAnswered` and `firstMissingAnswer` now share one predicate
(`fillAnswers.test.ts`). `FormQuestion.svelte.test.ts` mounts the card and asserts that each input
type hands its answer back to the PARENT - the one thing moving it behind a `$bindable` could break.

## Payment methods

The form UI offers Lydia and cash since 2026-10-07; Stripe and saved cards are gone from it.

| Method | Flow |
|---|---|
| Free | Direct submit, no payment |
| Lydia (online) | The payer types the address Lydia sends the request to (never stored); redirect to Lydia's payer page, return to `/forms/success?submission_id=...` (see the flow above) |
| Cash | Submit marked `pending_cash`, association admin validates manually before its deadline |

Online is offered only while the editor accepts it AND the association can collect; a form that takes
cash is answered in cash meanwhile - [drafts and publication](#a-form-is-a-draft-until-it-is-published-owner-2026-11-08).

A paid answer can be refunded from Canari, in full or in part, by a payout manager of the association
(the Achats tab, [payments](payments.md#refunds-from-canari-enrolment-lot-4)); a TOTAL refund turns the
answer `refunded`, which frees its seat and its single-answer slot.

**A paid answer is never deleted** (owner, 2026-11-14): `deleteSubmission` refuses `paid` and
`paid_over_capacity` with the typed 409 `FORM_ANSWER_PAID`, and the manager is told to refund or
cancel it instead - the payment's record keeps its Lydia Business either way
([lydia-contract-flux](../../lydia-contract-flux.md#enrolled-or-historical-the-discriminator)). A
`pending` answer is cancelled first by `cancelSubmission`'s rules, its Lydia request settled, so a
request left payable never lands on a deleted answer; one that cannot be settled is a 409
`PREVIOUS_PAYMENT_OPEN`, worded for the manager.

## Key component: forms/[id]/+page.svelte

The single form submission page handles the three payment flows. Key state:

- `form` — form definition loaded on mount
- `answers` — user-provided field values
- `paymentStep` — `'form' | 'payment' | 'confirmation'`
- `memberPricing` — a BOOLEAN returned by the API, never derived here. The fill page has no idea
  which tag or tier decides it, which is why swapping that rule server-side needed no change here.

### The submit response names no outcome, because a service with no locale cannot (2026-09-23)

`POST /api/forms/:id/submit` used to answer `{ message: 'Form submitted successfully', submissionId }`
and the page wrote `successMessage = res.message || m.form_view_submission_success()`. The server set
`message` on EVERY success, so the `||` never ran: `form_view_submission_success` - "Reponse envoyee !"
- was dead from the day it was written, and a French interface confirmed a submission in English. That
was not a fallback, it was an unreachable branch, which is why nothing ever reported it.

The response now only IDENTIFIES the submission (`{ submissionId }`) and the page says what happened.
The two other success shapes already worked this way and that is exactly why only one path showed
English: cash returns `{ submissionId, cashPayment: true }` and an online payment returns
`{ checkoutUrl, submissionId }`, neither carrying prose, so both fell through to Paraglide.

**A response field a client RENDERS cannot be written by a service that has no locale.** The server
may return a code or an id; the words are the client's.

The error half of the screen followed on 2026-11-06 (D6 of the forms audit): every refusal of the
submit path a person can meet now carries a typed `code`, and both fill pages word it through
`formSubmitRefusalMessage` - [answers, grids and refusals](#answers-grids-and-the-codes-a-submit-is-refused-with-2026-11-06).

## Answers, grids, and the codes a submit is refused with (2026-11-06)

From the forms capability audit of 2026-11-06 (`docs/wiki/forms-capability-audit-2026-11-06.md`, work package WP-G0).

**A form holding a visible grid could not be submitted from 2026-06-01 to this fix (D1).** A grid
(`matrix_single`, `matrix_multiple`) is answered `{ rowLabel: columnOptionId }` (a list of ids per row
for a multiple grid), and the fill page sent that map for every visible grid, answered or not. The DTO
validator `IsValidAnswers` (from `c586c84cb9`, 2026-06-01) accepted only a string, a string list or a
number per key, so the global `ValidationPipe` answered every such submit an English 400, member and
guest alike. Nothing caught it because every grid test called `FormsService.submit` directly, never
through the pipe. Now:

- **The shape** is accepted by `isAcceptedAnswerValue` (`apps/social-service/src/forms/answer-bounds.ts`):
  one level of object, at most `maxGridRows` keys, values a bounded string or string list.
- **The meaning** is judged in `submit` by `normaliseGridAnswer`: every key one of the question's
  rows, every value one of its column option ids (a list of distinct ids for a multiple grid), else
  400 `FORM_GRID_ANSWER_INVALID`. Empty rows are dropped, and a grid with no answered row is absent,
  so what is STORED holds only answered rows (the export's `answerText` already read a row map).
  A row map is a GRID's shape only: on a declared question that is not a grid it is the same 400
  (a page opened before the question changed type), on a key the form does not declare it is
  dropped (a stale page's `{ row: '' }` for a deleted grid must not fail the send). Rows are
  collected as entries, so a row labelled `__proto__` or `constructor` is an own key and never the
  prototype's. Booking spaces share the rule (`bookings.service.ts` `validAnswers`), and the
  space editor words a form's grid codes (`bookings/refusals.ts` falls back to `formCodeMessage`).
- **`forms.submit-grid.http.spec.ts`** boots the member and guest controllers behind the real
  `ValidationPipe`, configured as `main.ts` does, and submits grid answers over HTTP.

**A required grid wants ONE answered row (D5, decided 2026-11-06).** It demanded every row, so an
order ("which colours") could not be required. `requireEveryRow` (a per-question switch, "Exiger une
réponse dans chaque ligne", shown in the editor for a required grid) restores the old rule. One
predicate on each side: `isQuestionAnswered` (server) and `isItemAnswered` (client). The server's old
`!!val` also refused a required scale answered 0; the shared predicate counts a zero.

**Only answered questions are sent (D3).** `visibleAnswers` sent every visible question's EMPTY
selection too, so a form of more than 50 visible questions was refused whatever was filled. It now
sends answered questions only. The bounds live in ONE contract, `libs/contracts/form-answers.json`
(read by `answer-bounds.spec.ts` and `answerBounds.test.ts`): `maxQuestions` (100) bounds BOTH the
questions a form may hold at save (`FORM_TOO_MANY_QUESTIONS`) and the keys of an answer, so every
savable form is answerable in full; `maxGridRows` (50) bounds a grid's rows at save
(`FORM_GRID_TOO_MANY_ROWS`) and a grid answer's keys; `maxTextLength` (2000) and `maxSelections` (50)
are unchanged.

**A text answer shows its bound (D2).** The `long_text` textarea and the `short_text` input carry
`maxlength` = `maxTextLength`, and the textarea a "n / 2000 caractères" counter, so a cover letter is
stopped where it is typed instead of by an English 400.

**Two rows or two columns of one label are refused at save (D4).** The answer is keyed by the row
LABEL, so two rows "Vert" were one answer and one radio group. `assertFormItemsShape` refuses them
with 400 `FORM_GRID_DUPLICATE_LABEL` (forms and booking spaces); the editor marks the duplicate
inline ("En double") and the create and edit pages refuse the save first (`formItemsProblem`). The
fill page names a row's radio group by its index, not its label. Rows keyed by id are the
`product_grid` design (audit section 4), not this fix.

**Every refusal a person can meet on the submit path carries a code (D6).** `FORM_NOT_OPEN_YET`,
`FORM_CLOSED`, `FORM_FULL`, `FORM_ANSWER_MISSING` (with `itemId`), `FORM_ANSWER_TOO_LONG`,
`FORM_ANSWER_TOO_MANY_SELECTIONS`, `FORM_ANSWER_NOT_AN_OPTION` (a priced answer naming no option of
its question, `answer-options.ts`), `FORM_GRID_ANSWER_INVALID`, `FORM_COMBINATION_UNAVAILABLE` (403),
`FORM_SIGN_IN_REQUIRED`, `FORM_FILE_NEEDS_ACCOUNT`, beside the existing `ALREADY_ANSWERED` (the
anonymous path's second answer now answers it too, as a 409), `GUEST_PENDING_LIMIT` and the payment
codes. `formSubmitRefusalMessage` (both fill pages) maps a form code, then a payment code
(`providerRefusalMessage`), then the status (`describeApiRefusal`), then the page's generic line -
never `e.message`. The contract's `codes` list is asserted on both sides, and the client test fails
on a code with no sentence. What still carries no code: the `ValidationPipe`'s own 400 (a malformed
body the page cannot produce) and a file answer naming no uploaded file (`fileAnswersOf`), both
worded by the generic line. The create and edit pages map the save codes the same way, then the
status, then a generic sentence of their own - never `e.message` either.

**A question type this build does not know** (the coming `product_grid`) is drawn as "Mettez à jour
l'application pour répondre à cette question" (`FormQuestion.svelte`'s `{:else}`), and a required
one blocks the send with the same sentence (`firstMissingAnswer`, kind `update`), instead of an empty
card the server refuses.

## A form is a draft until it is published (owner, 2026-11-08)

**Why.** A paid form could not be built for an association before its Lydia was ready: every save of a
priced form called `assertPaymentsReady`, so the grid, the prices and the questions had to wait for
the onboarding. And a new form was answerable the moment it was saved. Both are fixed by one state.

**The state.** `forms.status` (migration 145): `draft` or `published`, default `published`, so every
form written before it - and every form an older container or an older client writes - is published
as it always was. A new client creates with `draft: true` (`CreateFormDto.draft`, create only; an edit
sending it is refused `400 FORM_DRAFT_FLAG_ON_EDIT`) and publishes with `POST /forms/:id/draft/publish`
(manager only; the write is `UPDATE ... WHERE status = 'draft'`, in the transaction that applies the
form's revision - the earlier `POST /forms/:id/publish` was removed before it shipped, one publication
route). **A form never goes back to draft**: a link, an answer or a reminder
handed out cannot be taken back. A client that sends no `draft` gets a published form at once, logged
`create without draft` ([legacy-compatibility](../../legacy-compatibility.md)).

**A draft is invisible to every respondent read.** One `where`, `respondentFormWhere` (`form-status.ts`:
id, not archived, `status = 'published'`), answers each of them, and a draft answers exactly what an
absent form answers, so its id cannot be probed:

| Read path | What a draft answers |
|---|---|
| `GET /forms/:id` (the fill page) | 404, except to its managers (`managesForm`: owner, global admin, MANAGE_FORMS) |
| `GET /forms/:id/check` | the absent-form shape, `maySubmit: false` |
| `POST /forms/:id/submit`, `POST /public/forms/:id/submit` | 404 |
| `GET /public/forms/:id` (the guest link `/f/:id`) | 404 |
| `POST /forms/:id/files` (`assertMayUploadAnswerFile`, `FormFilesService.upload`) | 404 |
| `POST /forms/:id/remind` (the opening reminder) | 404, so no reminder row exists for a draft and the reminder cron has nothing to send |
| A post attaching it (`createPost`, `updatePost`) | `400 FORM_IS_DRAFT` (`assertFormNotDraft`); the composer's pickers never offer a draft (`publishedForms`) |
| An agenda event linking it (`assertFormBelongsToAssociation`) | `400 FORM_IS_DRAFT`; `link-candidates` lists published forms only |
| The manager list `GET /forms` | listed, with a "Brouillon" badge and no share link or QR |

The engagement chantier's "openings for followers" (WP-2..WP-10, designed, not built) must read
through the same `where`: an opening of a draft is not an opening.

**A paid form is always saved; its publication waits on a way to pay (amended by the owner the same
day).** `payment-offer.ts` is the ONE rule, and the editor mirrors it (`publishBlocker`,
`frontend/src/lib/forms/publish.ts`):

- A paid form takes **online** payment (Lydia, "Paiement Canari") and/or **cash**. Online is now the
  editor's choice too: `forms."allowOnlinePayment"` (migration 145, default true - online was the only
  way before, so every existing form keeps it). Off with cash on is a cash-only form.
- **Saving** a draft never asks about readiness or the association's kind.
- **Publishing** a paid form (and creating one published at once, an older client; and every edit of a
  published one) needs its respondents able to pay NOW: cash accepted, OR online accepted and the
  association able to collect (`canTakePaymentsNow`, read lazily - not asked at all when cash already
  answers). Neither: `409 FORM_PAYMENTS_NOT_READY` ("Activez le paiement en espèces ou attendez que
  l'encaissement en ligne soit configuré"), or `400 FORM_NO_PAYMENT_METHOD` when the editor turned both
  off. The association's kind (`assertKindMayPrice`: an institution never collects, a list only through
  an approved delegate) is judged at the same moment.
- **The editor**: "Publier" is shut with that sentence under it; the payment section's warning stays a
  warning only without cash. With cash on and online not ready it is a note ("L'encaissement en ligne
  n'est pas encore configuré : les réponses seront payées en espèces pour l'instant") and no "Créer un
  formulaire gratuit à la place".

**A personal paid form** (no association) collects through the platform's own account: it is held
to the same rule - `FORM_NO_PAYMENT_METHOD` when neither way is accepted, served `paymentsPaused` when
its editor took online off - with no association readiness to ask.

**Two readiness predicates, deliberately.** Publication asks `canTakePaymentsNow`
(`resolvePaymentTarget`: can money be taken now, the platform's provider switch included); every read
serves `collectsNow` (may this association collect - its kind - and are its accounts ready; the
platform switch is the client's own read of `payments/provider`, so a member read never waits on
core-service). They agree on the accounts; publication also checks the kind through
`assertKindMayPrice`. Merging them would make every form read call core-service.

**The client asks the estate first.** The builder creates drafts only where `/api/version` says
`formDrafts: true`, and saves as before otherwise ([legacy-compatibility](../../legacy-compatibility.md)).

**A published paid form while online is not ready.** It stays published and readable (unchanged
behaviour, measured before this change): every read serves `paymentsPaused`, now
`charges && !(allowOnlinePayment && collectsNow)`. A respondent of a form that takes cash is offered
**cash only** - no online choice, never a dead Lydia button (`offersOnlyCash`, both fill pages) - and the
server refuses an online attempt: `FORM_ONLINE_PAYMENT_NOT_OFFERED` (409, before anything is written)
on a cash-only form, the existing readiness refusal (`PAYMENTS_NOT_ACTIVATED` / `PAYMENTS_BLOCKED`)
when online is accepted but not ready. A form without cash shows its online answer held, as before.
**Online comes back by itself**: `paymentsPaused` is derived on every read, so the first read after the
association becomes ready offers online again, if the editor kept it on. Guests keep the existing cash
rules (a public form's cash answer needs `cashPaymentExpiryDays`, and holds its seat until then).

**"Voir le formulaire"** (the forms list row, the editor's header) opens the respondent view in a new
tab (`target=_blank rel=noopener`, `formViewHref`): the live page for a published form, a PREVIEW
(`/forms/:id?preview=1`) for a draft or a published form holding unpublished edits - drawn from its
unpublished revision ([below](#edits-are-saved-as-they-are-typed-and-published-together-owner-2026-11-08)). The preview draws the questions, says it is one, shuts the send
button ("Envoi désactivé (aperçu)") and asks nothing of the reader's state (`isPreview`,
`routes/forms/[id]/+page.svelte`); the server would refuse a draft's submit anyway. Only what a
manager alone can read is a preview: the `preview` flag never shuts the send of a published form, so a
respondent handed such a link answers as usual.

Tests: `forms.service.draft.spec.ts` (create, edit, publish both ways, cash, idempotence, every read
path, the cash-only submit), `form-status.integration.spec.ts` (migration 145 on PostgreSQL, the
`where`, the conditional publish), `frontend/src/lib/forms/publish.test.ts`,
`FormSaveBar.svelte.test.ts`, `FormPaymentSection.svelte.test.ts`, `routes/forms/page.viewLink`,
`routes/forms/[id]/page.preview`, `routes/forms/[id]/edit/page.draft`.

## Edits are saved as they are typed, and published together (owner, 2026-11-08)

**Why.** An edit of a published form went live at "Enregistrer", and nothing was kept until then: a
closed tab, a dead battery or a lost connection lost the work, and a half-finished edit could not be
kept without showing it to respondents.

**Storage: one unpublished revision per form** (`form_drafts`, migration 146,
`form-draft-revision.ts`). `document` is the editor's whole payload - the body a `PATCH /forms/:id`
would carry - stored AS TYPED, a half-built form included; the form's own row keeps serving
respondents. `revision` is a compare-and-set counter that ONLY GROWS: a publication or a discard
empties `document` (NULL) and bumps it instead of deleting the row, so an editor still holding an old
number is refused rather than handed a fresh revision on top of a form it never saw. No author column:
nothing personal is stored beyond the form's own content (no register change). Two more columns:
`saveId`, the client's id for the save that wrote the revision, and `baseFingerprint`, the md5 of the
form's own content (`forms` minus its ids, the create key, dates, status and cover image) when the
revision STARTED - the first save after none, a publication or a discard. **A tier retag follows the
revisions** (`products.service.ts`, `followRetagInRevisions`): the retag that rewrites
`forms."cotisationVariantKey"` rewrites the same key, in the same transaction, in every open
revision of the association's forms that GRANTS the old key - the form granting it already, or the
revision turning the grant on (`grantsCotisation` in the document, else the form's own) - and
re-takes the base fingerprint of a retagged form's revision that was at its base: a retag is no
"change outside the revision", and no revision published later grants a key that no longer exists.
**The fingerprint check takes the form's row lock (`FOR UPDATE OF f`) on every publication,
`overwrite: true` included**, and a DRAFT with no revision is judged as its row stands under that
lock (`pessimistic_write`), never as the manager check read it before the transaction.
**Lock order: the `forms` row first, then `form_drafts`**, on every path that holds both - the
publication and the tier retag; a save or a discard locks `form_drafts` alone. The opposite order
was a deadlock (`40P01`) between a publication and a retag.
`recentSaveIds` keeps the last 32 save ids that wrote the revision, across a publication or a
discard: the ancestry a device copy is judged against (below).

| Route (managers only, `assertFormManager`) | What it does |
|---|---|
| `GET /forms/:id/draft` | `{ revision, document, savedAt, saveId, recentSaveIds }`; revision 0, no document when none was saved |
| `PUT /forms/:id/draft` `{ baseRevision, document, saveId }` | the autosave: ONE statement (base 0 inserts, later bases update only while the row holds them); a moved base is `409 FORM_DRAFT_CONFLICT` carrying the current `revision`, the `saveId` that wrote it and `recentSaveIds`; a non-object or a document over 1 MB is `400 FORM_DRAFT_MALFORMED`. The question images the document cites are claimed for the form in the same transaction, under the saver (an image uploaded before the form existed is the form's from then on, so a co-manager publishing later is not refused `QUESTION_IMAGE_NOT_YOURS`) |
| `POST /forms/:id/draft/publish` `{ revision, overwrite? }` | "Publier les modifications": in ONE transaction holding the revision's row, the document is validated as the edit route's body (`CreateFormDto`, `whitelist`), applied by `update` itself (every rule of an edit, payment readiness included), and emptied; a DRAFT form is published in the same transaction after its collection rules (`assertPublishable`). A refusal rolls everything back and the revision stays to be fixed. `409 FORM_DRAFT_CONFLICT` on a moved revision, `409 FORM_DRAFT_EMPTY` when a published form holds no change, `400 FORM_DRAFT_INVALID` with the validation messages, `409 FORM_CHANGED_SINCE_REVISION` when the form's fingerprint no longer matches the revision's base (something wrote the form outside the revision - an older build) unless `overwrite: true` confirms it |
| `POST /forms/:id/draft/discard` `{ revision }` | "Abandonner les modifications": empties it; a moved revision is refused, so another tab's edits are never thrown away unseen |

A concurrent autosave waits on the publication's row lock, then finds its base moved
(`form-draft-revision.integration.spec.ts` proves it on PostgreSQL). `GET /forms` marks each row
`hasUnpublishedChanges`; the list badges it ("Modifications non publiées") and its "Voir le
formulaire" opens the preview of those edits. A draft form may still change its anonymity at its
publication (no answer exists yet); a published one may not, as before. So may its association
([below](#a-drafts-association-may-change-a-published-forms-may-not-owner-2026-11-09)): the picker
stays open after the first autosave. What the FIRST create sent named is still remembered while that
create may have landed (no answer, a 5xx, or `FORM_CREATE_KEY_REUSED`) - its replay must name the
same association - but it no longer shuts the picker: a later choice rides in the revision. Any
other 4xx stored nothing, and the next create names the choice of that moment. The association's
"Formulaires" tab marks a draft too (`listFormsByAssociation` serves `status`), and its form card
stacks the actions under the title on a narrow card (`@container`, `@md:flex-row`): side by side,
they crushed the title to single letters on a phone (2026-11-08).

**An edit never writes the status.** `update` saves the form WITHOUT its `status` column: the row was
read before the edit's checks, and a publication landing meanwhile would otherwise be written back as
`draft`. **A create may carry an idempotency key, never an id** (`CreateFormDto.clientCreateId`, a
UUID v4 minted by the client; `forms."clientCreateId"`, unique per owner, migration 146): a second
create with that key by the same account answers the stored form (the insert race included - the
loser reads the winner's row); the SERVER mints every form id. A client choosing the id was refused
in review (2026-11-08): `posts."attachedFormId"`, `/f/:id` links, QR codes and posters may still
name a HARD-deleted form, and a create under that id would have put another account's form behind
them - and the "id taken" answer was an existence oracle. A key is looked up only among the
caller's own forms, so it answers nothing about anyone else's. An edit sending a key is
`400 FORM_CREATE_KEY_ON_EDIT`. A replay must be the SAME create: one naming another association is
`409 FORM_CREATE_KEY_REUSED`, one whose form was archived since `410 FORM_CREATE_KEY_GONE`. The
racing loser meets the winner at the key's unique index (`violatesUniqueIndex(err,
'forms_owner_client_create_id')`), or earlier at the claim of a question image the winner already
bound (`QUESTION_IMAGE_NOT_YOURS`): both answer the stored form. **A draft deleted for good is not
remembered**, decided 2026-11-08: a draft has no answer, so its deletion is a hard delete and frees
its key. A device copy that names the form (`formId`) meets the 404 and is dropped, told; one still
keyed by the create key alone - its create's answer never reached the device - would create the
draft again. That window needs a lost answer, the page closed, and the draft deleted from another
device before the next resend; what comes back is a DRAFT (no respondent sees it, no post or event
may name it) holding the manager's own latest typing, under a new id no link names. A tombstone
table to refuse it was judged more machinery than that case is worth.

**Question images cited only by a revision are cited.** `isCited` and the hourly reconciliation read
`form_drafts.document -> 'items'` as well as `forms.items`, so an image added in the editor outlives
the hour; a discard releases what only the discarded document cited, a publication what the published
revision dropped.

**The client** (`frontend/src/lib/forms/autosave.svelte.ts`, `FormAutosave`):

- every edit is saved after 1.5 s without another (`AUTOSAVE_DELAY_MS`), and AT ONCE when the page is
  hidden (`visibilitychange`) or left (`pagehide`) - those two ask the request to outlive the page
  (`keepalive`) when its body fits the engines' 64 KiB budget (`KEEPALIVE_BODY_MAX`); a larger one is
  held by the device copy below - and when the editor is torn down by an in-app navigation ("Retour",
  a link, the back gesture fire no `pagehide`: the `attach` cleanup and `beforeNavigate` save);
- **a save is named by its client** (`saveId`): a save whose answer was lost is recognised in the next
  save's 409, which names it, and ADOPTED - it landed - never reported as another tab's conflict;
- one save in flight, always the latest document: an edit typed meanwhile is sent on the revision that
  save produced, so one page never races its own compare-and-set;
- the status line under the summary: "Enregistrement...", "Enregistré", "Non enregistré - hors ligne"
  (no server answered), "Non enregistré - nouvel essai à la prochaine modification" (a refusal),
  "Modifié ailleurs entre-temps - rechargez la page pour reprendre" (a conflict: the page stops saving
  rather than overwrite the other tab);
- **offline edits are kept ON THE DEVICE (owner, 2026-11-08, replacing the page-only decision of the
  same day)**: every document is written to `CanariDBFormDrafts_<userId>` (`draftCopies.ts`, one
  record per form, keyed by the form's id, or by the create key until a create of it is answered:
  the base revision, the save id, the document, and `after`, the saves sent before it whose answer
  has not arrived - the one still ON ITS WAY included, from the moment it is sent) before it is sent, and deleted once its save landed (`deleteIfSent`: an answer to an
  older save never deletes a newer edit). The database is the account's: in `accountIndexedDbNames`
  (the account wipe) and erased at every sign-out (`clearAuthUnderway`) - **an INVOLUNTARY sign-out
  (an expired session, a revoked device) erases the unsent edits as well**: the next account on the
  device must neither see nor send them, and the session that typed them is gone. The store REFUSES
  every operation once its account is not the one signed in (`FormDraftCopyAccountGoneError`): a
  store captured earlier - an editor's teardown save on its way to `/login`, a resend pass in flight -
  can neither recreate the erased database nor read it into the next session. **A lost answer
  survives the page**: a save sent and never answered - or still in flight when the tab closed, its
  `pagehide` flush waiting on it - more typing, the app closed: the copy of the typing records that
  save in `after`, and whoever sends it next re-bases it on the revision
  that save wrote (`copyAgainst` on reopen, the resend on the 409 naming it) instead of dropping it.
  An editor reopened on the form opens on the copy when it is built on the revision the server holds
  (directly or through `after`) and sends it as the SAME save; one whose own save is in the
  revision's ANCESTRY (`saveId`, or `recentSaveIds`: it landed, and maybe another writer built on it
  since) is cleared with a debug line and no word to the member - nothing of it is lost; one built on
  a revision another writer moved past is dropped, logged at WARN,
  **and the member TOLD by a toast naming the form** ("Les modifications de « ... » gardées sur cet
  appareil n'ont pas pu être enregistrées ..."). **The background resend** (`draftResend.ts`, started
  by the layout once the session is up and the estate says `formDrafts`, again at each `online`)
  sends the copies no editor holds open - a shared Web Lock per form (`holdFormEditor`) tells it, in
  every tab - creating the form first under its create key when no create of it was answered, then
  re-keying the copy to the form's id. It reads `currentUserId()` before every request and every
  write, and ends the pass at the first change: a copy is never sent under another account's token.
  A copy that reached no server, or met a 5xx, stays; a 4xx (another writer's revision, a form gone
  or no longer the account's) drops it, logged at WARN, with the same toast. A conflict in a live
  editor KEEPS the copy while its edits are on screen: the page says "rechargez", nothing more is
  sent, and the reopened editor or the resend tells the member when it finds the copy unsendable;
- "Publier" / "Publier les modifications" first saves what is pending, and is shut while an edit has
  not reached the server ("Les modifications ne sont pas encore enregistrées sur le serveur"). **An
  edit typed WHILE the publication runs is kept** (`closed(revision, 'published')`): it becomes the
  first save of the next revision, rather than vanish - blocking the inputs would freeze the manager
  for a request's length. That includes an edit whose save LEFT during the publication: sent on the
  old base, its 409 is read by nobody (`#era`), and its document is re-sent on the new revision, its
  device copy kept until it lands. A discard drops it (`'discarded'`): the manager asked for the edits to go;
- **"Publier" is shut by the server's own rule, mirrored**: `formChargesMoney` and
  `publishPaymentRefusal` (`publish.ts`) mirror `chargesMoney` and `publishPaymentRefusal` on the
  server (every way to charge, a personal form included), and both sides assert
  `libs/contracts/form-publish-payment.cases.json`;
- the editor opens on the revision when there is one, and takes its "nothing changed" baseline once
  the question cards have mounted (a card completes its question's defaults when drawn), so opening a
  form saves nothing;
- the create page mints the create's key (`crypto.randomUUID()`, the client post id pattern) and
  creates the draft at the first pause after a title (a shell: the title and the association) under
  it, then saves the rest as its revision: a create whose answer was lost is sent again as the same
  create, and the server answers the form it minted.
  Question images uploaded once the draft exists name it; one uploaded before is bound by the save. A
  reload of the create page starts a new form; the draft already saved is in "Mes formulaires" with its
  badge, and edits a closed create page left unsent reach it through the background resend;
- **an estate older than revisions** (`formDrafts` absent from `/api/version`, or no answer yet): the
  editor reads no revision and saves as it always did ("Enregistrer les modifications" writes the form),
  the create page creates the form published ([legacy-compatibility](../../legacy-compatibility.md));
- **"Voir le formulaire" in the editor saves the pending edit first**: the tab is opened at the press
  (a popup opened after an await is blocked) and pointed at the preview once the save returned;
- **a revision refused `FORM_CHANGED_SINCE_REVISION`** says so ("Ce formulaire a ete modifie ailleurs
  ..."), and "Publier" becomes "Publier quand meme", which sends `overwrite: true`;
- **no refusal is worded by `e.message`** on either page: a publication, a discard, a load and an
  image upload or removal map their codes, then the status (`describeApiRefusal`), then a generic
  sentence of their own (`form_publish_failed`, `form_discard_failed`, `form_edit_load_error`,
  `form_builder_image_upload_failed`, `form_image_remove_failed`).

**Two readiness predicates, kept apart on purpose.** PUBLICATION asks `canTakePaymentsNow` (the
platform's active provider, through core-service): may this form go live as paid now. A READ asks
`collectsNow` (the association's kind and accounts, no core-service call) to serve `paymentsPaused`
on every respondent read. Unifying them would put a core-service call on every respondent read; the
publication gate is the stricter one, and a form served paused only shows cash.

Tests: `forms.service.revision.spec.ts` (autosave, a lost answer's save id in the 409, images bound
at the save, stale revision, atomic publish with rollback, a form changed since the revision and its
overwrite and its lock, payment rules, draft-form publication, discard, the create key - repeated,
raced, another owner's, refused on an edit), `form-draft-revision.integration.spec.ts` (migration
146, one-of-two saves, growth only, rollback, the lock, the save id, the fingerprint and the cover
image it ignores, a tier retag reaching the revision), `form-order-ref.integration.spec.ts` (two
racing creates under one key: one row, a server-minted id; another owner's same key: another form), `form-item-images.integration.spec.ts` (an image only a revision cites),
`autosave.svelte.test.ts` (debounce, hidden, left, torn down, single flight, offline then online, a
lost answer adopted, the device copy, conflict keeping it), `draftCopies.test.ts` (the store over
fake-indexeddb, the re-key, the sign-out erase and a late put refused, `copyAgainst`, the resend's
outcomes including a predecessor re-based and an account switch mid-pass, an editor's hold, and the
whole lost-answer-then-typing-then-close sequence), `FormSaveBar.svelte.test.ts` (the status line, publish and discard),
`routes/forms/[id]/edit/page.draft`, `routes/forms/create/page.returnNoRoute`,
`routes/forms/page.viewLink`, `routes/forms/[id]/page.preview`.

## The admin screens

`forms/create` and `forms/[id]/edit` are two thin pages over one set of components. They were two
700-to-900-line copies of each other until 2026-08-23, and the copies had drifted in eight ways a
user could see (two toggle sizes on one screen, a select missing its focus ring, two different
placeholders on the same picker, a cash-expiry field that was a bare input on one page and a
labelled component on the other). Everything shared now lives in one place:

| Piece | What it owns |
|---|---|
| `FormSection.svelte` | The card: icon, title, optional badge, optional collapsing |
| `FormPaymentSection.svelte` | Beneficiary, the single-price / grid toggle, payment methods, cash |
| `FormQuestionsSection.svelte` | The builder list, drag-and-drop, the type picker |
| `FormAdvancedSettings.svelte` | The collapsed "advanced" category: responses, audience, cotisation |
| `FormSaveBar.svelte` | The footer summary and the save button |
| `pricing/PriceGridEditor.svelte` | The criteria (two at most to add) and the "Critère" menu; titled "Prix d'inscription" on a form - see [the price table](#the-price-table---two-criteria-rows-by-columns-owner-2026-11-06) |
| `pricing/PriceCellsEditor.svelte` | The 2D price table, its header bulk bar, and the phone's cards |
| `pricing/CriterionEditor.svelte` | One criterion as compact rows: a line per group, chips, a "+" offering what is left |
| `pricing/bucketValues.ts` | A group's values as chips, and the values no group holds yet |
| `AudienceConditionEditor.svelte` | One condition's criteria, used by the form AND by a question |
| `pricing/priceMatrix.ts` | The matrix state, its cross product, and the payload it becomes |
| `pricing/criteriaOptions.ts` | The promo / formation option lists a criterion offers |
| `forms/audience.ts` | The pre-save guard against a condition with no criterion |
| `pricing/CotisationTierPicker.svelte` | Picks a tier BY NAME |
| `ui/controlClasses.ts` | The one class string every input and select wears |
| `ui/Select.svelte`, `ui/Toggle.svelte` | The select and the switch, one geometry each |
| `forms/cotisationSettings.ts` | The cotisation state, and the payload it becomes |
| `forms/itemsPayload.ts` | Questions to/from the wire, euros to/from cents |
| `ProductGridEditor.svelte`, `ProductGridPreview.svelte` | A priced grid's table editor and its buyer's preview |
| `forms/productGridEditor.ts` | The priced grid's editor model, its payload and its pre-save check |
| `forms/summary.ts` | The save bar's one line: question count, and what the form costs |
| `forms/gridProblem.ts` | One sentence per `GridProblem` code, for the editor AND the save button |

Section order, top to bottom: **General** (title, description, poster), **Payment**, **Questions**,
**Advanced settings** (collapsed). The two pages carry the SAME sections in the SAME order: a
setting reachable only once a form exists is a setting a manager cannot plan for.

### The question editor is one line per question (owner, 2026-11-06)

The owner: *"on peut carrément compresser l'interface d'édition des formulaires, là c'est beaucoup trop d'espace et de choses inutiles."* Four decisions, all answered, plus one added the same day.

1. **Collapsed questions, one line each** (like Google Forms): number, handle, title, type icon and name, an asterisk when required. Clicking the line (or Enter / Space on it) expands it; **only one question is expanded at a time**, the list (`FormQuestionsSection`) owning which. Escape collapses and returns focus to the row. A question just added or just duplicated is created expanded, and expanding moves focus to its title. A form loaded for editing starts fully collapsed.
2. **The grey preview box is deleted** ("L'utilisateur verra un champ court..."): the type's icon and name say it. Choice lists, scale and matrix editors stay, they are the content. A FILE question's explanation (who reads the file, when it goes - `fileHint`, which a booking space overrides, else `form_builder_file_hint`) is a visible muted line under the open card: a tooltip is invisible on touch.
3. **One icon row at the bottom of the open card**, in this order: Obligatoire (asterisk toggle), Conditions (opens the "show only to certain people" panel, `AudienceConditionEditor`, only while switched on; the long explanation is the tooltip), Dupliquer, Supprimer; on touch, where there is no drag handle, two reorder arrows follow, and a collapse chevron ends the row. Every icon has an accessible name. The "show if another answer" picker pair (`dependsOn`) is unchanged and sits above the row.
4. **No visible field labels.** The title is the main field, larger, placeholder "Question sans titre"; the type is a compact menu beside it (icon only below `sm`). The labels remain as `aria-label`s.
5. **Duplicate, easy** (added the same day): the icon on the collapsed row (hover or focus on desktop, always visible on touch), the icon row, and **Cmd+D on Apple platforms, Ctrl+D elsewhere** on a focused question (the browser's bookmark shortcut is cancelled; Shift, Alt and auto-repeat copy nothing). The copy is inserted right AFTER the original, opens expanded with its title selected. It copies everything (`questionDuplicate.ts`) under a NEW question id and new option and row ids. The original keeps its id, so conditions in OTHER questions keep pointing at the original. The copy's own answer condition stays valid because its source is before the original; one that is not (a stale reference to itself or a later question) is dropped and logged. A copy is an ordinary added question: the server rules for a form that already has submissions apply exactly as for any new question.

**A save refused because of a question opens that question.** A folded card hides its own error, so the pages hand the id to the section through `reveal`, a fresh object each time (`questionFault.ts`): the first question with an empty audience condition, and the first grid `formItemsProblem` refuses (a duplicated row or column, too many rows), so its "En double" mark is visible. A form-level refusal (the file rule on a public or anonymous form) has no question to blame: the page scrolls its error banner into view instead of opening a card. After a delete, focus goes to the row that took the place, else the previous row, else the "add a question" button. The form-level option toggles (public, anonymous, tiered pricing) live outside the question cards and are untouched. The drag rule of #3081 applies (a press on a button, field or label never starts a drag), so a collapsed row, whose body is a button, drags from its grip: a 44 x 44 px `data-drag-handle` shown from `sm`; touch reorders with the arrows of the open card. The collapsed row, the grip and the duplicate icon are at least 44 px.

Tests: `FormQuestionsSection.svelte.test.ts` (collapsed / expanded, one at a time, asterisk, conditions panel, reveal, Escape, duplicate by icon and Ctrl+D), `questionDuplicate.test.ts` (the copy's contents, ids, position, references).

### Four sections, because six of them buried the common case

The screen carried six top-level cards on 2026-08-26, and a manager writing a plain free form -
title, questions, save - scrolled past every one of them. A response cap, a repeat switch, an
opening date, an audience restriction and a cotisation grant are each wanted by a handful of forms a
year, so they moved into **Paramètres avancés** as three groups separated by dividers: *Réponses*
(cap, repeats, shotgun date), *Qui peut répondre* (`submitCondition`), *Cotisation* (the grant).

A folded section holding a live restriction is a setting nobody can see, so the header carries a
**badge**: `Accès restreint` when `submitCondition` is set, otherwise a count of the settings that
are actually doing something. The audience wins over the count because it is the one that decides
whether a person may answer at all.

**Payment is a MODE, not two half-live displays.** The section used to show the single price and the
grid together, with the price relabelled "Prix par défaut" and used only to seed a new cell - two
numbers on screen, one of which charged nobody. It is now one toggle: either `Prix de base public`
or the grid, never both. Switching the grid on seeds it from the price that was on screen (so no
total changes), switching it off drops it, and removing the last criterion leaves the grid ON with
nothing to divide on - the mode is the manager's to flip, not the editor's.

That state is a save-time refusal (`no_criterion`), because `matrixPayload` sends null for a grid
with no dimension: the save would look accepted while quietly keeping the single price.

### The save bar says the same thing on both pages

`formSummary` exists because the two pages had drifted: create printed the price, edit printed only
the question count, so one form summarised itself two ways depending on which door you came in by.
A grid gets a RANGE (`8 - 20 €`) rather than one number, since it has no single price. Two
duplicated `_short` error keys went the same way - the long sentences are the ones both pages use.

## Pricing is a MATRIX, so no priority rule exists to get wrong

A price used to be one number plus an optional "cotisants pay less" second number. What managers
actually price on is several things at once - the BDE cotisation depends on the promo, the formation
AND the answer to a menu question. Expressed as an ordered list of rules, that needs a priority
rule, and a priority rule is a thing to get wrong: two rules both matching one person, and whichever
sorts first wins for reasons nobody wrote down.

So the ticked "Filtrer par..." boxes declare **dimensions**, and the grid is their **cross product**.
Exactly one cell applies to any given person, so there is nothing to prioritise, and completeness is
a save-time invariant rather than a runtime hope.

Two properties make that work:

- **A dimension is a PARTITION, not a filter.** Every criterion carries the buckets a manager wrote
  plus one generated, undeletable `others` bucket (`OTHERS_BUCKET_ID = '_others'`). Without it a
  dimension leaves the people it does not name unpriced; with it the cross product stays small and
  everybody lands in exactly one cell.
- **A question used as a dimension contributes no additive `priceModifier`.** Its cell already
  carries the choice, so a supplement on top would charge it twice. The server enforces it
  (`pricedQuestionIds`), and the builder hides the per-option supplement fields for those questions.

`pricing/price-matrix.ts` resolves a subject to a cell, `pricing/validate.ts` refuses an
incomplete or self-contradicting matrix at save time, and `pricing/audience.ts` holds
`matchesCondition` plus `PricingFacts` - the promo, formation and cotisation facts assembled by
`pricing/pricing-facts.service.ts`.

**The module sits at `src/pricing/`, not under `src/forms/`** (moved 2026-08-31). A boutique product
prices on the same grid, and a shared mechanism kept inside one consumer is a mechanism the second
consumer copies. `PricedSubject` is the one thing that varies: it selects the wording of a refusal
("this form" vs "this product") and nothing else, so a single validator can say what is wrong in
terms the manager on that screen recognises. A product's `CriteriaContext.questions` is EMPTY, which
is exactly what refuses an `answer` dimension on it - a product has no questions to price on, and
that refusal costs no code of its own.

### The price table - two criteria, rows by columns (owner, 2026-11-06)

Redesigned for `1.6.6` from the owner-approved mockup ("Prix d'inscription"); a UI change only, the
stored grid is untouched and an existing form opens unchanged. The editor is shared by forms,
boutique products and cotisation tiers, so all three get it.

- **Two criteria at most.** The "Critère" menu (Promotion / Formation / Cotisation / Réponse à une
  question) greys a used kind ("Déjà utilisé") and every kind once two are set ("Deux critères au
  plus : retirez-en un"), and `add` refuses too (`MAX_CRITERIA`). The SERVER has no such bound
  (`parsePriceMatrix` maps any number of dimensions), so a stored grid with three still loads and
  saves: `gridAxes` nests every criterion but the last down the side, and every cell is still one
  row by one column.
- **A true table.** `gridAxes` puts the first criterion's groups down the side and the second's
  across the top, the corner naming both ("Promotion \ Formation"); one criterion is a single price
  column. A row or column header selects the line and opens a bar with "Même prix partout" and
  "Tout rendre indisponible" (`lineCellKeys` + `fillCells`). "Masquer les lignes indisponibles"
  hides a row whose every cell is `null` (`rowUnavailable`) - display only. **Drawn as ONE ruled
  table (owner, 2026-11-07: "un vrai tableau a double entrees", compacted)**: the headers are the
  table's own `th` cells, tinted, with no gap and no floating card, so a row header is exactly the
  height of its row (2.5rem; 2rem for the header row) and a column header sits over its column; the
  rules are the cells' borders (`border-collapse`), the rounded box around the table draws the
  outer edge, and a cell is one line (price, `EUR`, "Gratuit" chip, corner button) instead of a
  4.75rem box. An unavailable cell stays hatched and struck through, just smaller. The phone keeps
  its cards.
- **Empty is "Gratuit", said.** A cell priced `0` shows an empty box and a muted "Gratuit" chip: the
  semantics of an empty cell did not change, they are now visible. `parseEuros` reads an empty box
  as 0, a comma as a decimal point and ignores spaces (a pasted "1 000,50"); it ROUNDS TO THE CENT,
  the rounding `matrixPayload` applies, so the box shows what will be saved, and refuses a negative
  or an amount whose cents are not a safe integer. Text that is not a price leaves the cell as it
  was, and the box is rewritten from the grid either way.
- **Unavailable is drawn as a closed priced-grid cell**: `.price-cell-closed`, hatched and struck
  through. `.price-cell`, `.price-cell-closed`, `.price-free-chip` in `app.css` are the shared cell
  classes, for the priced-grid question (WP-G3) to wear too.
- **The guest's free seat is flagged where it is fixed.** On a public form, `guestFreeCellKey`
  mirrors the server's `freeFallbackCells` (`answer-options.ts`, PR #3084's rule): only the TRUE
  fallback - "Tous les autres" on every criterion, each reachable, priced 0, in a grid that charges
  someone. That cell carries "Un invité ne peut pas avoir un tarif gratuit" and a status line under
  the table names it.
- **Criteria are compact rows**: one line per group (an underlined name, the values as chips, a "+"
  that offers only what no group of the criterion holds - the server refuses overlapping groups;
  a promo offers the six most recent unplaced years and takes an older one typed), and "Tous les
  autres" as one muted line. A new group is named "Groupe N" at once.
- **A MULTIPLE-choice question takes ONE group** (2026-11-11). A person can tick options of two
  groups, and `bucketFor` takes the first group in the grid's order that any ticked option matches,
  so two groups would make the price depend on their order - and adding an option could pick a
  cheaper cell. The server refuses such a grid at create, and at an edit that INTRODUCES the split,
  with the typed code `FORM_GRID_MULTIPLE_CHOICE_SPLIT` (in `libs/contracts/form-answers.json`; the
  editor's sentence comes from `formCodeMessage`, never from the server's prose)
  (`assertMultipleChoiceGridOneGroup`, `answer-options.ts`; `forms.service.public.spec.ts`). A form
  that already STORES such a split, unchanged, on a question already stored as multiple-choice, stays
  saveable - refusing it would refuse an edit of its title - and each such save logs
  `[FORM_GRID_SPLIT] form <id>` at WARN, so the forms predating the rule are counted. One
  group ("ticked at least one of these") and "Tous les autres" stay allowed, and a single-choice
  question keeps any number of groups. The editor offers no second group on such a criterion and
  says "Choix multiple : un seul groupe" instead (`takesOneGroup`, `bucketValues.ts`;
  `PriceGridEditor.svelte.test.ts`).
- **A phone (< 640px)** gets one card per row with a labelled pill per price; a tap opens an inline
  editor under the card, a hold toggles availability. Nothing scrolls sideways.

### A cell may say the combination DOES NOT EXIST

Some configurations are not sold: "non-cotisant, formule week-end" is a combination the association
never offers. A price cannot say that - 0 means free - and `submitCondition` cannot either, since it
is an AND of criteria and this is a *combination* being excluded, not a person. So a cell is
`CellValue = number | null`, and `null` is the manager's decision that nobody in that situation may
answer (added 2026-08-26, on the user's request to be able to close the grid for "tous les autres").

Three states, never to be confused, and the whole design rests on telling them apart:

| Cell | Meaning | Who honours it |
|---|---|---|
| a number | the price, `0` included = free | `submit` charges it |
| `null` | the combination does not exist | `submit` REFUSES; the fill page greys the option out |
| absent | broken invariant - completeness is enforced at save | `resolveCellPrice` throws |

`hasCell` is the one predicate that separates them, mirrored on both sides. The invariant is
untouched: the grid is still complete, exactly one cell still applies to anybody, and there is still
no priority rule. What changed is that the cell a person lands in may refuse them.

Where each part of that lives:

- **Editor**: a cell toggles between a number and `Indisponible` from a button in its CORNER, or
  a touch hold (`longPress`); an open cell owes its click to the caret, so the corner overlays it
  and costs no width (`.cell-action`, shown on hover or focus, always on a coarse pointer). Coming
  back restores `0`, shown as "Gratuit". A grid with EVERY cell unavailable is refused on both
  sides (`all_unavailable`, `assertMatrixValid`): that is a closed form, not a priced one.
- **Geometry**: `.price-grid` in `app.css` owns the column sizes; the editor supplies only the
  price-column count (`--group-col` 9rem, `--price-col` 8rem, `--price-row` 2.5rem). The total width has to be NAMED: `table-layout: fixed` on a table of width
  `auto` treats column widths as PROPORTIONS - nine columns declared at 8rem inside a 1020px box
  measured 83-91px in Chrome, and unequal. With the total named, every price column is exactly its
  declared size and the wrapper scrolls once they no longer fit.
- **Server**: `resolveCellPrice` returns `null` rather than throwing, and `submit` refuses right
  after it - not in `assertMaySubmit`, because only the VISIBLE answers decide which cell applies.
  `hasSubmission` reports `maySubmit: false` when the submitter's whole row is closed, the same
  outcome as an audience refusal.
- **Fill page**: `pricingViewFor` writes every combination explicitly, `null` included. The page's
  old `cells[key] ?? baseCents` was exactly the fallback that would have priced an unavailable
  combination; it now refuses instead, greys out the options that lead to a closed cell (shown, not
  hidden - an option that vanishes reads as a bug), and disables the submit button.
  **A required priced question not answered yet has chosen no cell** (`pricedQuestionsAwaitingAnswer`,
  `forms/fillAnswers.ts`): until it is (`priceDecided`), the page says nothing about the price - no
  "from" price in the header, no total in the footer or on the button, no "Combinaison indisponible"
  - and closes no option of ANOTHER priced question (`page.pricing.svelte.test.ts`). Its blank used to fall
  in the "others" group and called "Cotisation BDE 2026" unavailable before any answer (Mi 9T,
  v1.2.9-alpha.3). An OPTIONAL priced question left blank still prices as "others", as the server does.

### What the app knows about a person, and why a price may rest on it

Measured on prod 2026-08-23, `auth_db.users`, 221 rows:

| Attribute | Values seen | Comes from |
|---|---|---|
| `formation` | `ICM` 213, `ISMIN` 3, `Master` 2, null 3 | Authentik `userinfo`, refreshed at every login |
| `promo` | 2022 (4), 2023 (15), 2024 (72), 2025 (101), 2026 (24), plus 2020, 1850, 1816, null 2 | idem |
| cotisation tier | `AssociationProduct` rows, `type='membership'`, per association | the association's own catalogue |

Three facts shape the feature:

1. **Neither attribute is self-declared.** `UpdateUserDto` carries `bio` and nothing else; `promo` and
   `formation` are written only by `findOrCreateFromOidc`. That is what makes them safe to price on -
   the payer cannot move themselves into a cheaper cell. **If that DTO ever gains `promo`, this
   becomes a self-service discount**, which is why the warning is written at the DTO itself.
2. **`formation` is a small OPEN vocabulary, not an enum.** The next value arrives from Authentik with
   no deploy, so the picker offers what EXISTS and the `others` bucket catches what it has not seen.
3. **Both can be null**, and five rows on prod are. A null is not an error and must price.

`promo` is an **ENTRY year**: la promo 2024 is the cohort that entered the school in 2024. That is
the whole definition, and the prod distribution above corroborates it - 2025 is the largest cohort
and 2026 already exists, which no graduation reading explains.

**It was read as a graduation year here, and that was wrong.** On that reading a bucket needed a
second, relative mode - `yearsToGraduation`, computed as `promo - academicEndYear` - so that "1A"
would not go stale every September. The mode shipped and matched NOBODY it was ever set for: for the
promo 2025 evaluated in 2026 the expression yields -1, while the editor only ever offered 0..4. The
absolute mode was no better off, offering a six-year window (`end-1..end+5`) that contained no cohort
on prod and omitted the three largest that do.

A relative mode cannot be repaired, either: it needs a cursus length, and nothing in this platform
records one (ICM and ISMIN run three years, Master two). So there is **one reading and no mode**. A
group names its years and the manager names the group - `{ id, label: '2A', values: [2024] }` - and
"les anciens" is a group naming several years. What a manager re-types once a year is a number they
can see, which is strictly better than a mode that silently priced a cohort as "everyone else".

The years a manager may pick run from **1816** (the school's founding year, and therefore the oldest
promo there can be) to the current calendar year. The bound is enforced on BOTH sides - `promoYears`
in `criteriaOptions.ts`, `FIRST_PROMO_YEAR` in `pricing/validate.ts` - because `2O24` typed for
`2024` matches nobody for ever, and a criterion that silently matches nobody is what this module
refuses everywhere else.

## One predicate, three uses

The criteria that divide a price grid are the same criteria that gate a question and gate the form:

| Where | Field | Meaning |
|---|---|---|
| The form | `submitCondition` | Who may submit at all |
| A question | `showIf` | Who sees this question |
| A price cell | the dimension buckets | What this person pays |

All three are `AudienceCondition`, all three are judged by `matchesCondition`, whose keys are ANDed.
One editor component builds all of them, so a form reserved to one promo and a price for that promo
cannot disagree.

### Conditional questions are evaluated on the SERVER now

`dependsOn`/`dependsValue` used to be a browser-only rule, which had two live consequences: `submit`
enforced `required` on hidden questions while the client sent only visible answers (so a required
question behind a condition made the form unsubmittable for the people the condition excluded), and
an answer to a hidden question was accepted with its price modifier charged. Both get much worse once
an answer can select a price cell, which is why `forms/visibility.ts` landed with the matrix rather
than after it. It stayed in `forms/` when the rest moved to `src/pricing/`: a product has no
questions, so nothing outside a form can ever ask it anything.

`visibleItemIds` is memoised, order-independent, and resolves a dependency cycle to *hidden* - a
question depending on itself has no defensible answer, and hidden is the reading that charges nobody.
`normaliseCondition` folds the legacy `dependsOn` pair into `showIf.answer` so exactly one evaluator
exists, and **ANDs the two shapes**: the builder offers both controls on one question, so "only for
cotisants" and "only if Q1 = menu B" are two requirements of one question. `showIf.answer` wins over
the legacy pair when both name an answer.

### The submit button says what the catalogue says

`submitLabel` looked like a manager's setting and never was one: no screen has ever offered a field
for it, both admin pages wrote a hard-coded French literal computed from `requiresPayment`, and the
fill page rendered it raw with `|| 'Envoyer'` behind it for the rows the entity default had left as
`'Submit'`. An English viewer read French. Migration `052` drops the column; the label is a Paraglide
message derived from `requiresPayment` at render time. If a per-form label is ever wanted, it comes
back as a message KEY or a translated map, never as one language's sentence in a column.

### A condition with no criterion is refused, twice

An empty condition applies to everybody, so it restricts nothing and hides nothing. The server
refuses it (`parseAudienceCondition`), but that refusal is a developer sentence about a document -
not what a manager should read for having flipped a switch and stopped. So `forms/audience.ts`
catches it before the request, naming the form or the question it belongs to.

### A cotisation NOT held: `notCotisation` (owner, 2026-10-30)

A form, or one question, can be reserved to people who do **not** hold a given cotisation - the
creator picks the tier ("BDE" in a `dated` association is this academic year's tag, so "not
BDE 2026-2027"), and nobody pays it twice. The editor's cotisation criterion has a mode, "Detient la
cotisation" / "Ne detient pas la cotisation" (`cotisationModeOf` / `withCotisationMode` in
`frontend/src/lib/forms/audience.ts`); the tiers ticked are kept when the mode flips.

- **Its own key, `notCotisation`, same shape as `cotisation`** (`anyTier` = holds no tier of the
  association at all). Not a `negate` flag inside `cotisation`: a 1.5.1 editor rebuilds
  `cotisation` from its checkboxes and would DROP the flag, silently turning "not a cotisant" into
  "cotisant"; it spreads an unknown key through untouched. `parseAudienceCondition` refuses the two
  keys together - one criterion, one mode - and validates the tiers exactly as for `cotisation`.
- **The server is the only judge, as for every profile criterion.** No client evaluates promo,
  formation or cotisation: `GET /forms/:id/check` answers `maySubmit` and `hiddenItemIds`, so a 1.5.1
  client shows a holder the form as closed and the question as hidden without knowing the key exists.
- **The refusal is typed** (`forms/submit-refusal.ts`): `submit` and the file upload answer
  `403 { code: 'FORM_COTISATION_HELD' }` to a holder, `403 { code: 'FORM_NOT_OPEN_TO_YOU' }` for any
  other failed criterion. `failedCriterion` (`pricing/audience.ts`) names the criterion that failed,
  `notCotisation` first, and `matchesCondition` is `failedCriterion(...) === null`. The check carries
  the same code as `refusalCode`, which is how the fill page says "Vous detenez deja cette cotisation"
  rather than "Ce formulaire ne vous est pas destine".
- **Re-judged when the money lands, INSIDE the locked grant, on a form that GRANTS a cotisation.**
  `fulfilPayment` (online and cash alike) hands the form's `notCotisation` to
  `UserTagService.grantCotisantIfARise`, which decides under the buyer's tier lock - so a shop
  settlement that committed while the form's payment was in flight is SEEN. It refuses a held tier
  of that set (`EXCLUDED_TIER_HELD`) and, on every granting form, the very tier already held
  (`held`): the old rule renewed it, taking its price twice from a holder - the same case submit
  refuses as `FORM_TIER_ALREADY_HELD`, now judged again when the money lands. No path wanted that
  renewal (paid forms are the rule's only caller); the one held tag still answered `granted` is
  this answer's own delivery (`metadata.submissionId`), a replay that writes nothing. A refusal is
  recorded `paid_not_granted` - the existing refund-owed marker the purchases tab and the hourly
  report show, closed by a manager; no new mechanism. A throw of the lock or a read releases the
  grant claim (`failed`) for a replay, never a refusal on a read that failed.
- **A replay reaches the same verdict from durable state.** When the record write failed and is
  replayed (`grant === null`), `formTierDelivered` asks whether the tier is held AS THIS ANSWER'S
  DELIVERY (`holdsTierDeliveredBy`: the tag names this `submissionId`), not merely held - a tier
  bought in the shop is held but not delivered, and its refund stays owed. The manager hint
  (`target-held`), the hourly line and the buyer's status say it: already held when the payment
  landed - refund, do not grant by hand.
- **A form that grants nothing keeps the seat it sold**, holder or not: it took no cotisation's
  price, so nothing was paid twice, and refusing the seat after the money would turn an admitted,
  paid answer into a refund for a rule whose only purpose is not charging a cotisation twice.
- **A 1.5.1 editor sends both keys** when a manager ticks a held tier on a "ne detient pas"
  condition (it spreads `notCotisation` through and adds `cotisation`): refused
  `400 { code: 'AUDIENCE_COTISATION_BOTH_MODES' }`, worded by a newer client through Paraglide; the
  older one shows the English sentence, which says to update the app.
- **Old forms are unchanged**: an absent key is no constraint, and no stored row carries it.
- Booking spaces share the editor and the predicate, so a space's audience gets the mode too.

Tests: `pricing/audience.spec.ts`, `pricing/validate.spec.ts`, `forms/submit-refusal.spec.ts`,
`forms/forms.service.matrix.spec.ts` ("a form for people who do NOT hold a cotisation"),
`frontend/src/lib/forms/audience.test.ts`.

## Cotisations: a form names a TIER, never a tag

This is the rule the whole cotisation surface turns on, and it is the one thing to read before
touching it. See migration `050_forms_cotisation_by_reference.sql` for the full reasoning.

A form stores **which tier**, and the tag is derived at grant time:

| Column | Meaning |
|---|---|
| `grantsCotisation` | A paid submission grants the association's cotisation |
| `cotisationVariantKey` | Which tier is granted. **NULL = the base tier**, not "any tier": "who counts as a member" is a set, "what does payment grant" is exactly one |

The member price is no longer a column. `memberPriceEnabled`, `memberPriceVariantKey` and
`basePriceMember` were "cotisants pay less" spelled as three columns and one hard-coded discount
axis; migration `051_form_price_matrix.sql` drops them, because a cotisation tier is now just one
dimension a price grid may be divided on, alongside promo, formation and an answer. Production held
one form, with `memberPriceEnabled` false and `basePriceMember` null, so nothing needed migrating.

The predecessors — `pricingTagName`, `grantedTagName`, `tagExpiresAt` — stored a literal tag string
typed into the admin screen, and were dropped. Three things were wrong with a literal, all silent:

1. **It went stale.** A dated cotisation's tag carries the academic year. A form configured in June
   stored `cotisant:bde-2025-2026`; submitted in October it granted a tag for a year that was over.
   `provisionCotisationProduct` resyncs the association's products on every slug or mode change;
   nothing resynced a form, and nothing could — the form did not record which tier it meant.
2. **It could not name a tier.** A multi-tier association got the base tag or a hand-typed guess,
   which is the "cotisant nobody can see" that `grantCotisant` refuses to mint.
3. **It bypassed the XOR.** Granting a raw tag through `grantOrRenew` skipped
   `revokeSiblingTierTags`, so a user could hold two tiers at once by buying one in the boutique and
   the other through a form.

Granting now goes through `UserTagService.grantCotisant`, the same call the boutique and the manual
roster add use, so all three are impossible by construction.

### Where the tier list comes from

`GET /api/associations/:id/cotisation-options` -> `{ tiers: { variantKey, name }[], mayGrant }`.

One call answers both questions the screen has: what may be offered, and what this caller is allowed
to do with it. `mayGrant` is `MANAGE_MEMBERS` on that association (or global admin) - see the gate
below. Not `:id/cotisation-tiers`, which requires `MANAGE_MEMBERS` merely to *read* and carries the
derived `tagName` no screen has any use for; the tier list here is unguarded for the same reason
`:id/products` is, since a tier's NAME is already public on the association page.

**No screen ever renders a `variantKey`, an id, or a tag.** The picker shows `name`; the key travels
on the wire only. `AssociationTagAutocomplete` and `GET :id/tag-catalog` were deleted along with the
raw-tag UI that was their only caller.

### Granting a cotisation needs MANAGE_MEMBERS, pricing on one does not

Creating a form needs nothing but an account. Linking it to an association needs MANAGE_FORMS in it
(owner, 2026-11-14: *"seuls les membres d'association qui avaient la permission 'gerer les
formulaires' pouvaient gerer les formulaires"* - membership alone used to be enough, never decided,
an early implementation's `isMember`; see [who manages an association's forms](#who-manages-an-associations-forms-owner-2026-11-14)). But
`grantsCotisation` hands out association membership, and `UserTagService.grantCotisant` has always
required `MANAGE_MEMBERS` - so a plain member with `MANAGE_FORMS` could save a form whose grant would
be refused at payment time, or, worse, use the form as a side door around the flag that guards the
roster. `assertCotisationConfigValid` now takes the caller and refuses the setting itself, and
`mayGrant` hides the toggle so nobody picks an option the save would reject.

Dividing a price grid on a cotisation tier is deliberately NOT gated: charging existing cotisants a
different amount grants nothing and changes no one's membership.

### Who manages an association's forms (owner, 2026-11-14)

ONE predicate, `FormsService.managesForm`: a global admin; for an ASSOCIATION's form, MANAGE_FORMS in
that association (`mayAct`: a BDE super-admin of it included), whoever created it; for a PERSONAL
form, its owner. Its creator is no manager by authorship: one who never held MANAGE_FORMS (possible
until this date, when membership was the creation rule) or no longer does loses the form, and
"Mes formulaires" (`list`) no longer lists it. A create naming an association, and a draft moved
from or to one, need MANAGE_FORMS there - else `403 FORM_ASSOCIATION_NOT_YOURS`, typed at the throw
(`assertManagesAssociationForms`); the builders offer only those associations
(`formManagedAssociations`). Measured read-only on production that day: 1 of 15 live association
forms had an owner without MANAGE_FORMS in its association. The fee schedule of the payout
estimate follows (`mayEditAPrice`, [lydia-contract-flux](../../lydia-contract-flux.md)): a form's
creator is not a price editor by being its creator.

## An anonymous form keeps no author (2026-09-30)

A manager can mark a form **anonymous** at creation (`forms.anonymous`, migration 067). It is the
promise *"the server cannot tell you who answered what"*, and it is kept by what is STORED, not by
what is displayed:

| | Named form | Anonymous form |
|---|---|---|
| `submissions.userId` / `email` | the submitter | **NULL** |
| `submissions.createdAt` | the instant | **cut to the UTC day** - a precise clock would re-join the two tables by order alone |
| "has this account answered" | a `submissions` row | `form_respondents (formId, userId)`, which names **no answer and no time** |
| Responses list and XLSX | newest first, name columns | **random-id order**, no name column, date without time |

The registry insert and the answer are ONE transaction (`ON CONFLICT DO NOTHING ... RETURNING` is
what refuses a second answer from the same account). `allowMultipleSubmissions` still works and then
registers nobody.

**Free only, refused where it is chosen** (the shared option rule,
[below](#which-options-rule-each-other-out-one-rule-in-either-order-2026-11-06)): a payment names its
payer to the processor and to the submission, and a cotisation is granted TO an account. A price, a
grid, cash, a cotisation grant and an option supplement are all refused; the editor shuts the
payment switch and the anonymity switch against each other, with the reason as the hint.

**Fixed once published**, like a published form's association link (a draft may still change it): turning it on later would promise
anonymity to answers already stored with a name, and turning it off would quietly start naming
people who were told they were not. `update` refuses a present, different value; the edit screen
shows the toggle read-only.

What it does NOT hide, stated so nobody over-reads it: an audience restriction (`submitCondition`,
`showIf`) is still judged against the submitter's profile at submit time, and a question that asks
for a promo or a formation on a small group re-identifies its answerer by itself. The fill page says
only what is stored, not more. Database history (WAL, backups) taken while the answer was written is
outside this mechanism.

## A public form is answered without an account (2026-09-30)

A manager can make a form **public** (`forms.isPublic`, migration 068, switch in "Paramètres
avancés"). Anybody holding its link answers at **`/f/:id`** - no session, no app chrome, no login
redirect (`+layout.ts` lets `/f/` through as it does `/legal`). A member who opens that link is sent
to `/forms/:id`, where the form knows who they are; the share button and the QR code of a public form
hand out the `/f/` address - the forms list and the detail page both through `formSharePath`
(`lib/forms/shareLink.ts`), decided from `isPublic`. A `/forms/:id` link already in circulation for a
public form is answered by the root guard: with no session confirmed, `guestPathForMemberLink` asks the
endpoint the guest page reads (`GET /api/public/forms/:id`, 404 for anything not public) for the
`/forms/<uuid>` shape only, and routes to `/f/:id` on an answer, to login otherwise (logged
`[FormLink]`). `/f/` is deliberately not in the universal-link claim (`appSiteAssociation.ts`): a guest
link opens in the browser; `/forms/*` stays claimed so an installed app gets the guard above.

**Everything follows from a guest having no identity** (the shared option rule
[below](#which-options-rule-each-other-out-one-rule-in-either-order-2026-11-06), then
`assertPublicConfigValid`, refused at save time with a code and shown on the save bar):

| A guest has no... | so a public form... |
|---|---|
| account to grant to | grants no cotisation (refused at save, and `fulfilPayment` refuses it again for a guest row - ERROR, no grant) |
| profile to match | has no `submitCondition` and no question shown by promo, formation or cotisation (an ANSWER condition is fine). A price grid on promo, formation or cotisation IS allowed (owner, 2026-11-06): a guest lands in the "everyone else" group of each such criterion and pays that tier |
| account to charge | still CHARGES (WP-P1, decision PP1): a base price, a grid, option supplements, online payment to the e-mail it types, or cash |
| identity to recognise twice | takes several answers (`allowMultipleSubmissions` is forced on) - identify guests by asking their name or e-mail ([below](#a-guests-name-and-e-mail-when-the-form-asks-2026-11-06)) |

## Which options rule each other out: one rule, in either order (2026-11-06)

The owner found the editor asymmetric: a grid by promo shut "Formulaire public", but switching the
form public FIRST and adding the grid afterwards was accepted - each switch carried its own copy of
the rule. Now **one pure function** decides: `frontend/src/lib/forms/formOptionRules.ts` =
`apps/social-service/src/forms/form-option-rules.ts`, copied byte for byte and held so by the
`declared-duplicates` gate (no shared TS package, as for `answerText.ts`). Each pair is ONE row of
`FORM_OPTION_CONFLICTS`:

- the editor shuts a switch when `conflictsIfEnabled(state, option)` is not empty, whichever of the
  two was on first, and its hint lists every real reason and nothing else (`conflictHint`,
  `formOptionConflict.ts`); the save button runs `formConfigConflicts` before sending;
- the server runs `formConfigConflicts` in `assertFormOptionsCoherent` on create, and on update over
  the form AS IT WILL BE SAVED (the edit merged onto the stored form), and refuses with a 400 whose
  body carries `code`.

| Options | Verdict | Code | Why |
|---|---|---|---|
| anonymous + payment (price, grid, cash, supplement) | refused | `FORM_ANONYMOUS_PAYMENT` | paying names the payer |
| anonymous + cotisation grant | refused | `FORM_ANONYMOUS_COTISATION_GRANT` | a cotisation is granted to an account |
| anonymous + file question | refused | `FORM_ANONYMOUS_FILE` | a file is tied to its uploader |
| anonymous + "Autoriser la modification de la réponse" | refused | `FORM_ANONYMOUS_ANSWER_EDIT` | an anonymous answer names nobody who could reopen it ([changing an answer](#a-respondent-changes-their-own-answer-owner-2026-11-13)) |
| public + restricted audience, or a question shown by promo, formation or cotisation | refused | `FORM_PUBLIC_AUDIENCE` | a guest has no profile to check |
| public + cotisation grant | refused | `FORM_PUBLIC_COTISATION_GRANT` | a guest has no account |
| public + file question | refused | `FORM_PUBLIC_FILE` | a guest has no account to upload with |
| public + payment | allowed | - | WP-P1: a guest pays with the e-mail it types |
| public + grid on promo, formation or cotisation | allowed | - | the guest pays the "everyone else" tier |
| public + grid whose every guest cell is unavailable | refused | `FORM_PUBLIC_GUEST_TIER_UNAVAILABLE` | no guest could answer: a public form in name only |
| every other pair | allowed | - | |

**The guest's tier is never a client's number.** `PricingFactsService.build` with no user answers no
promo, no formation and no cotisation without asking anyone, `bucketFor` puts that in `_others` on
every profile criterion, and `submit` prices the cell from those facts
(`forms.service.seat-hold.spec.ts`, "charges a guest the everyone else tier"). The "everyone else"
group always EXISTS - a grid is complete at save (`assertMatrixValid`) - so a guest always has a
cell; what a manager can do is close it, which is why the closed case is refused rather than a rule
"an others tier must exist". A guest cell at **0** is refused by `freeFallbackCells` only when it is the TRUE fallback, "everyone
else" on EVERY criterion with each reachable; a cell naming an option ("Sans repas : 0") is a free
choice and is accepted, and so is a member tier at 0 (the manager's business).
The editor says it under a public form's grid by promo, formation or cotisation: "Les invités paient
le tarif « autres »".

Not in the table, because they read a value rather than two options: a public form forces several
answers on (the editor sets it with the switch), a public form taking cash needs a deadline, and the
free-fallback check above (`assertPublicConfigValid`).

A guest's answer is a `submissions` row with `userId` NULL and its real time (cut to the day when the
form is ALSO anonymous); the responses table names it "Invité". The two routes live in
`PublicFormsController` under `/api/public/forms/` - nginx strips every identity header there - and
the page calls them with plain `fetch`, never `apiFetch`, whose refresh-and-retry is for a session.

**No captcha**: the edge that offered one is gone. Two guards instead:

- **A throttle of 30 answers per minute per visitor** (`ClientIpThrottlerGuard`). Building it found
  that no per-IP throttle here had ever been one: the container nginx overwrote `X-Real-IP` with the
  Docker gateway, so prod logged the bridge gateway's address for every visitor and the existing "20/min per IP" on
  `/api/public/` was 20/min for everybody. The container now takes the client from the host proxy
  (`set_real_ip_from` the private ranges, `real_ip_header X-Real-IP`) and the guard keys on that
  header. A room of guests behind ONE NAT (a school network at an event) shares an address, which is
  why the limit is far above what one person types.
- **A honeypot** field (`website`), off-screen and out of the tab order. A filled one is answered
  `{ ok: true }` like a real answer, stored nowhere, and logged.

**A guest pays (WP-P1, [chantier](../../public-paid-forms-chantier.md))** through the member's
paid path, with `userId` NULL: the same seat lock and 30-minute hold, the same `markPaid`. What a
guest cannot steer, the server sets: a `userId` or `email` in the body is dropped (a name or e-mail the form asked travels in its own fields, [below](#a-guests-name-and-e-mail-when-the-form-asks-2026-11-06)), and the Lydia
return URL is `/f/:id`, never one the client names. `getPublic` is an allowlist (price, currency,
cash, the answer-grid slice) and the submit reply is one too (`toGuestSubmitReply`: the payer page or
"cash owed", never the submission id). A guest's purchase record has `userId` NULL (migration 103);
the association's Achats tab names it "Invité". Both fill pages total with ONE rule,
`lib/forms/fillPricing.ts`.

### A guest's name and e-mail, when the form asks (2026-11-06)

Owner's decisions of 2026-11-06, built for `1.6.6`. **Off by default**: a guest is asked nothing
about who they are. The creator ticks any of **Nom / Prénom / E-mail** ("Demander aux invités",
`GuestIdentitySettings.svelte`, drawn under the "Formulaire public" switch while it is on) - three
independent choices stored as `forms.guestFields` (jsonb, migration 138: a canonical list drawn from
`lastName`, `firstName`, `email`; null asks nothing, and an empty list is stored as null). The
settings advise ticking them on a public form, firmly on one that charges ("Conseillé pour un
formulaire payant : retrouver qui a commandé").

| Rule | Where |
|---|---|
| A ticked field is REQUIRED of a guest; a field not ticked is REFUSED (400 `FORM_GUEST_IDENTITY_NOT_ASKED`), so the columns hold only what the creator asked | `guestIdentityFor` (`apps/social-service/src/forms/guest-identity.ts`), called in `submit` before anything is written or issued; a missing one is 400 `FORM_GUEST_IDENTITY_MISSING` |
| Lengths: a name 100 characters, the e-mail 254 and shaped like one | `GuestSubmitFormDto`, `libs/contracts/form-answers.json` (`maxGuestNameLength`, `maxGuestEmailLength`) |
| A member is never asked, and a member's answer carrying any of them is REFUSED, not stripped (the member DTO declares them so the global `whitelist` cannot drop them silently) | `SubmitFormDto`, `guestIdentityFor(..., 'member')` |
| An anonymous form cannot ask them: refused at save with `FORM_ANONYMOUS_GUEST_IDENTITY`, judged on the form as it WILL be saved (an edit's list, else the stored one) | `judge()` in `assertFormOptionsCoherent`, beside the shared option pairs; not a pair of `form-option-rules.ts`, since the editor never sends guest fields on an anonymous form |
| **The e-mail is never asked twice**: when asked, it is the address Lydia's request goes to (`guestPayerEmail`) and the payment step asks nothing - a second `payerEmail` beside it is REFUSED (400 `FORM_GUEST_IDENTITY_NOT_ASKED`), never dropped; when not asked, the payer address is asked at the payment step and never stored, as before (PP2) | server `guestPayerEmail`; page `payerPromptNeeded`, the "Utilisé aussi pour le reçu Lydia" note under the field while the answer pays online |
| Stored on the answer: `submissions.guestLastName`, `guestFirstName` (varchar 100), `guestEmail` (varchar 254), all nullable; null on every member's answer | migration 138 |
| The fill page draws a "Vos coordonnées" block after the questions, only when the form asks one; a held send scrolls to it; "answer again" empties it (a shared device at an event) | `GuestIdentityFields.svelte`, `routes/f/[id]/+page.svelte` |
| Responses: a guest's row shows the name it gave (else the e-mail) BESIDE its reference and the "Invité" badge - never the name alone, which would pass for an account's | `submitterName` / `guestShownName` (`submissionTable.ts`), `FormSubmissionsTable.svelte`, and the pending-cash list of the association's Formulaires section (`EditFormsTab.svelte`, which named a row by account id alone until 2026-11-07, so a guest paying cash crashed the section into a 500); the manager allowlist (`submission.projection.ts`) carries the three fields |
| Export: a guest's names fill the first/last name columns, and a guest marker column (`labels.guest`, "Invité") holds each guest row's reference, written whenever a row has no account; an "E-mail" column is written when the form asks it, or an answer carries one from when it did (`labels.email`); the grid sheet's buyer is "Marie Curie (Invité 1A2B-3C4D)", else "Invité 1A2B-3C4D" (`guestLabel`) | `exportSubmissions`, `addProductGridSheets` |

**Erasure and retention.** `submissions.guestEmail` is `kept` in `ACCOUNT_ERASURE_COVERAGE`: it is
written only on rows with no account, so no account's erasure can reach it (the names are not
account-shaped columns). They live as long as the answer - the submissions rule, which is still
**none (OPEN)** in register row C8; a guest's own request is answered by hand, the row
anonymised rather than deleted ([data-subject-requests](../../compliance/data-subject-requests.md#a-guest-with-no-account-a-public-forms-answer-register-c8)).

**Older clients (P3-4 of the review of #3096).** The export's word list gained `email` and `guest`
(the guest marker column, each guest row's reference beside the name it typed, so a typed name
never reads as an account's). As with `file` before it, the server refuses an export that would
write one of those columns without its word - so a store build older than `1.6.6` gets a 400 when
it exports a form holding a guest's answer (the `guest` column) or asking the e-mail. Updating the
app is the fix; no default word is substituted ([`export-labels.ts`](../../../../apps/social-service/src/forms/export-labels.ts)). Register C8 and the privacy
policy say so. Tests: `forms.service.guest-identity.spec.ts`, `guest-identity.integration.spec.ts`
(migration 138 applied twice, the stored columns, the Lydia address), `guestIdentity.test.ts`,
`GuestIdentitySettings.svelte.test.ts`, `routes/f/[id]/page.guestIdentity.svelte.test.ts`,
`FormResponsesPanel.svelte.test.ts`.

### At most three answers waiting per visitor (WP-P3, decision PP5)

A guest's paid answer holds a seat while it waits (30 minutes online, until the cash deadline in
cash), and a public form takes any number of answers from one link - so one script could fill an
event with answers nobody pays. `submit` refuses a visitor's FOURTH waiting answer on a form with a
429 `GUEST_PENDING_LIMIT` (`guest-visitor.ts`, worded by `paymentRefusal.ts`).

- **Counted from the rows, under the form's seat lock**, like the capacity count: a guest's paid
  answer carries `guestVisitorKey` (migration 105) and the count is its rows still WAITING - an online
  one within its hold (`livePendingWhere`), a cash one not validated. A paid, cancelled or expired
  answer frees its place at once, with no job.
- **A cash answer has a deadline, always**: a public form that accepts cash is refused without
  `cashPaymentExpiryDays` (at publication and on every edit; the editor says so under the field).
  An edit that sends an explicit `null` is judged on that null, since that is what it saves. A form
  that charges nothing is not asked: it never reaches cash, so a cash flag left over from when it
  charged is not read (`chargesMoney`). Without a deadline, an unpaid cash answer would hold its seat and its visitor's place for ever, and three
  of them from one shared network would shut that network out of the form.
- **The visitor is its address** (`clientAddress`, the `X-Real-IP` nginx sets - the throttle's own
  key, one function for both). An IPv6 address counts as its **/64** (`visitorNetwork`): a host is
  routinely given a whole /64 and picks its address in it at will, so keyed on the full address one
  visitor would be 2^64 visitors to the throttle and the ceiling. An IPv4-mapped address is its
  IPv4. The key is never the address: an HMAC-SHA256 of the form id and
  the address (keyed, because a plain hash of 32 bits is reversed by trying them all; per form, so
  two forms' rows cannot be joined). Its HMAC key is DEDICATED: HKDF-SHA256 of `INTERNAL_SECRET`
  under the label `canari:guest-visitor-key:v1` (`guestVisitorHmacKey`), never the raw secret, which
  authenticates calls between services. No secret, no key: `submit` throws rather than store an
  unkeyed hash.
- **Kept only while it counts**: `forgetSettledGuestVisitors`, in the 5-minute expiry tick (its own
  `try`), clears the key of every answer no longer waiting. Register row C8 and the privacy policy
  say so.
- **The paid path keeps the free path's guards**: the honeypot drops a paid answer before any row or
  payment, and the route keeps `ClientIpThrottlerGuard` at 30 per minute (both asserted in
  `public-forms.controller.spec.ts`).
- **Known cost**: guests behind ONE address (an event hall's network) share the ceiling - three
  can wait to pay at once, the fourth waits a moment or pays later. Not measured ("to evaluate" in
  PP5).
- **Known cost, kept on purpose**: a filled honeypot answers `{ ok: true }`, which on a PAID form a
  bot can tell from a real reply (no payer page): the honeypot catches form-fillers, it does not
  deceive them. Making the two identical was weighed and refused (2026-10-22): a real online reply
  carries Lydia's payer page, which exists only once a payment request was created AT LYDIA - for a
  bot, to an e-mail it typed, which would make the honeypot a relay of Lydia's e-mails - and a forged
  URL is found out by fetching it. A bot that compares replies also reads past a hidden field, so
  the ceiling and the throttle, not the honeypot, are what bound it.

### The guest's return from Lydia: a receipt, not an id (WP-P2) - A SECURITY SURFACE

A member's return page (`/forms/success`) is authorised by the session; a guest has none, and the
submission id is no proof (it travels in URLs and logs). So `submit` mints a **receipt** for each
guest answer paid online (`guest-receipt.ts`): 32 random bytes, handed out ONCE in the Lydia return
URL `/f/:id/receipt?receipt=...`, stored only as their SHA-256 (`submissions.guestReceiptHash`,
migration 104, `select: false`). Cash needs none: the guest reads the reference on the page that
sent the answer.

- **The receipt is the only key.** `POST /api/public/forms/receipts/confirm` (receipt in the BODY,
  out of access logs) finds the row by the hash and by nothing else. A malformed receipt, an unknown
  one, a submission id or a leaked hash all answer the same 404 (`GUEST_RECEIPT_NOT_FOUND`), with no
  provider read.
- **It confirms as the member's return does**: `confirmPayment`, Lydia read server to server about the
  row's OWN request. Nothing else in the URL is read, so a forged return never marks a row paid; a
  receipt replayed after settlement only reads (no provider call, no second record). The verified
  callback settles a guest row on its own, with no return at all.
- **The answer is an allowlist** (`GuestReceiptView`): reference, form id, amount, currency, status,
  the provider state read on this call - never the submission id.
- **Throttled per receipt** (`GuestReceiptThrottlerGuard`, keyed on the HASH) at the member's
  `CONFIRM_PAYMENT_PER_MINUTE`; anything that is not receipt-shaped counts on the visitor.
- **The reference** ("1A2B-3C4D") is the id's first eight hex digits (`guestReference`). It grants
  nothing; the organiser's responses table files a paying guest under it (`toManagerView`'s
  `reference`), so the guest quotes it and the organiser finds the row. No e-mail is sent (PP2).
- **The receipt stays in the URL, ON PURPOSE**: it is the link the guest reopens while the payment
  confirms (PP2), so the page does not strip it (`history.replaceState` would leave a guest who
  closes the tab with nothing). What it would leak is cut where it is cheap (2026-10-22):
  - the front nginx's access log drops the receipt route's query (`/f/<id>/receipt?query-redacted`,
    the `$logged_request_uri` map in `Dockerfile.frontend`, asserted by
    `access-log-redaction.test.mjs` and run against a real nginx);
  - every `/f/` page is answered with the HEADER `Referrer-Policy: no-referrer` (the
    `$capability_referrer_policy` map, sent by `@ssr` and `@app_shell`, asserted by
    `static-headers.test.mjs` and run against a real nginx), so the page's own requests - its
    chunks, the confirm call, the retry link - do not carry the URL into that log's referer field.
    It has to be a header: the page boots on the client, so its first chunk requests leave before
    a `<meta>` could apply. The page still carries the `<meta>` for a shell served without that
    header (a dev server).
- **Residual risk, stated**: the receipt stays in the guest's browser history, in Lydia's copy of
  the return URL, and in any proxy in front of this container that logs full URLs (outside this
  repository's control). It does not expire. What bounds it: it only READS one answer's reference,
  amount and status, and asks Lydia about that answer's own request (throttled per receipt); it
  cannot pay, cancel, edit or reveal the answers, the payer or the submission id.

Both return pages share one poll (`lib/forms/paymentReturnPoll.ts`). Each attack above is an
integration test on a real Postgres (`guest-payment.integration.spec.ts`), with its mutation control
written beside it.

**What a priced answer may say (2026-10-22, `answer-options.ts`), for members and guests alike** -
the price is only as good as the answer it is computed from:

- **A visible question that decides a price** - one the grid prices on, or one whose options carry
  a supplement - accepts only its own declared options:
  - one id for a single choice or a dropdown, a list without duplicates for a multiple choice;
  - anything else is a 400: an unknown id would match no group and no supplement, and land on the
    "everyone else" price while reading as the choice it names.
- **The question's TYPE says whether its options charge**: only a single choice, a multiple choice
  or a dropdown. A question turned into a matrix keeps its old options as columns; its answer is an
  object that never charged, so it is not judged, and the editor stores those columns at no price
  (`itemsPayload.ts`).
- **Two questions never share an id** (`assertUniqueItemIds`): every reader resolves a question by
  its id, and two readers resolving a duplicate differently would judge one question and price
  another.
  - **When it applies:** at create, and on an edit whose questions' ids differ from the stored ones
    (a question added, removed, reordered or re-identified). The refusal names both questions, by
    position and label, so the organiser can fix them.
  - **What it never blocks:** a duplicate ALREADY STORED never blocks an edit that leaves the ids as
    they are - a title, a deadline, closing the form. The edit page resends the whole list on every
    save, converted for the API (`itemsPayload.ts`), so the list is compared by its ID SEQUENCE,
    never byte for byte.
  - **What that costs:** an edit that changes a duplicated question's CONTENT but keeps its id is
    not refused either; the next change to the ids is.
  - **It depends on no count.** For the record, a read-only count on 2026-10-22 (one SELECT over
    `forms.items`, no write) found NO form holding two items with one id: 0 of 8 on production, 0 of
    1 on dev. The guard would therefore have refused no stored form either way.
- **The stored answer is the priced one.** The answer to a question the submitter did not see
  (`visibleItemIds`) is neither charged nor required, and it is no longer stored either, nor is its
  file attached.
- **A public form that charges cannot leave the reachable "everyone else" cell at 0** (the one where
  every criterion is "everyone else"; a named option at 0 is accepted)
  (`freeFallbackCells`, checked at publication and on every edit of a public form). That cell is
  reached when a priced question can be skipped (not required), hidden (it has a condition), or
  answered with an option no group holds. The manager prices that cell or marks it unavailable; a
  required, unconditional question whose every option is grouped never reaches it, so a 0 there is
  accepted.

## A respondent changes their own answer (owner, 2026-11-13)

A per-form switch, **"Autoriser la modification de la réponse"** (`forms.allowAnswerEdit`, OFF by
default, migration 166), lets a respondent WITH AN ACCOUNT reopen their own answer and change it.
The owner's decisions are final; the reasons below are why the code holds them.

**Who and when.**

- Only the account that wrote the row. A guest's row (`userId` NULL) is nobody's, so a guest is
  never offered it; on an ANONYMOUS form the switch is shut (`FORM_ANONYMOUS_ANSWER_EDIT`, one row of
  [the option rule](#which-options-rule-each-other-out-one-rule-in-either-order-2026-11-06), on both
  sides) and a stored `true` beside `anonymous` is refused at the edit anyway (`FORM_ANSWER_EDIT_OFF`).
- Only while the form is OPEN: after `opensAt`, before `closesAt`, not closed by hand
  (`assertFormOpen`, the submit's own check: `FORM_NOT_OPEN_YET` / `FORM_CLOSED`).
- Only a row that IS an answer (`answerHoldingWhere`: paid, free, a live pending one, pending cash,
  paid over capacity). A cancelled, expired or refunded row is `FORM_ANSWER_NOT_EDITABLE`.
- Another person's row answers exactly what an absent one does: 404 `FORM_ANSWER_NOT_FOUND`.

**The price is never moved by an edit - the LOCK RULE** (`apps/social-service/src/forms/answer-edit.ts`,
`editLockedItemIds`). No top-up and no partial refund exist, ever. So every question that can change
what is charged is LOCKED:

- a priced grid (`product_grid`): its quantities are the order;
- a question the price grid divides on (an `answer` criterion of `priceMatrix`);
- a choice question with an option supplement (`decidesPrice`; the TYPE decides, as at submit);
- CLOSED UNDER VISIBILITY: every question whose answer shows or hides a locked one (`showIf.answer`
  or the legacy `dependsOn`), transitively - hiding a priced question drops its supplement or moves
  the person to the "everyone else" cell, a price change made one question away;
- **the lead's REVERSIBLE decision (2026-11-13)**: once the answer's cotisation was GRANTED
  (`cotisationGrantedAt`), the question that decides admission on a granting form (the ANSWER
  criterion of `submitCondition`) is locked too, like a price. No question chooses the tier itself
  today (the tier is the form's `cotisationVariantKey`), and every granting form charges, so its
  priced questions are locked already; this line only closes "change the answer that let me buy".
  To reverse it, drop the `grantMade` branch in `editLockedItemIds`.
- **the lead's REVERSIBLE decisions (2026-11-13), what the ROW says**: the lock set of an answer is
  today's rule UNITED with every question the row recorded of its price (`rowLockedItemIds`, closed
  under visibility like the rest): the `itemId`s of its stored `lines` (migration 137), and its
  SNAPSHOT `submissions."priceLockedItemIds"` (migration 166), written by `submit` - and by a retry
  that re-prices the row - with the questions today's rule says the price depends on at that moment
  (`priceSnapshot`). So a grid unpriced, or a supplement REMOVED, after answers were priced with it
  still locks its question on those rows (`answer-edit.integration.spec.ts`, "keeps a question
  locked on a row priced with its supplement, after the supplement is removed"). **The residual, for
  rows written before migration 166 only** (snapshot NULL): today's rule and `lines`, so a supplement
  removed after such a row was priced unlocks that question there - the answer may then disagree
  with `totalPaid`, never the money with what was charged. To reverse: drop the third argument of
  `editLockedItemIds` (and stop writing the snapshot).

**When does the lock start - the unpaid-but-requested decision.** The owner preferred "locked as
soon as a payment request exists". The rule is STRICTER: the price-affecting questions are locked
on EVERY answer from the moment it is sent - paid, pending online, pending cash, AND free. Why:
re-pricing a free answer would read TODAY's profile and grid (a promo or a cotisation acquired since,
a cell the manager changed), and an edit from a 0 EUR cell to a paid one would be a top-up - the one
thing that may not exist. One rule for every status is also one rule a reader can predict. A free
answer to a form whose priced questions are all 0 EUR still has them locked; the hint in the editor
says so.

What an edit therefore NEVER writes: `totalPaid`, `lines`, `priceLockedItemIds`, `paymentStatus`, the payment ids, the
seat, the cotisation grant. It never reaches the payment provider.

**The server enforces it; the client only draws it.** `FormsService.editAnswer`
(`PUT /api/forms/:id/submissions/:submissionId/answers`, body `{ answers }`):

1. the switch, anonymity, openness, the answer sizes (`assertAnswerSizes`, the submit's own);
2. `judgeEdit`, outside the locks (the profile read may call core-service): grid answers normalised;
   a locked question SENT with a different value is 409 `FORM_ANSWER_LOCKED` naming it (a locked one
   repeated or omitted is fine - the stored value is carried); then the submit's own checks over the
   merged answer: the ANSWER half of `submitCondition` only (who the person is - promo, formation,
   cotisation - was judged when they answered, and a form selling a cotisation with `notCotisation`
   would otherwise refuse every buyer's edit once they hold it), declared options on the editable
   questions, `required` on the editable ones (`FORM_ANSWER_MISSING`), and an answer the person
   cannot see DROPPED as at submit - except a locked one, which is what was priced and stays whatever
   their profile says today;
3. the write, in ONE READ COMMITTED transaction: `lockFormSeats` (the form row, `FOR UPDATE`), then
   the submission row `FOR UPDATE` - the order `submit` and `markPaid` take them. The row is re-read
   there; ownership and `answerHoldingWhere` are checked again; every locked answer is compared with
   the row AS IT IS NOW (`sameAnswer`: empty spellings equal, a multiple choice a set, a grid by its
   non-empty cells), so a retry, a payment or a grant committed meanwhile refuses rather than
   overwrites; then `answers` and `editedAt = now()` - nothing else.

**Version skew.** The client offers the switch and "Modifier ma réponse", and asks the routes below,
only on an estate whose `/api/version` says `formAnswerEdit: true`; an editor older than the switch
saving a form keeps the stored value ([legacy-compatibility](../../legacy-compatibility.md#no-date-yet---an-answer-editor-newer-than-its-server---formansweredit-2026-11-13)).

`GET /api/forms/:id/my-answers` lists the caller's rows that may be changed, newest first, each with
its `lockedItemIds`; empty when the switch is off, the form anonymous or not open. The fill page
reads it, offers "Modifier ma réponse" under the sent answer (or a "Vos réponses" list on a form
taking several answers - each is changed separately), draws the locked questions disabled with one
line ("Fixe le prix payé : ne peut plus être modifiée."), hides the order bar, the payment choice and
the total, and sends the visible answers LESS the locked ones (`editedAnswers`, `fillAnswers.ts`) -
re-sending them through a read-back that might spell them differently would only risk a false 409.

**Capacity.** The model has ONE cap, `maxSubmissions`, counted in answers; there is no per-option
capacity. An edit keeps the same row, so it keeps its seat and never takes a second one: a full form
still lets its respondents change their answers, and the form lock is taken anyway so an edit is
serialised with every submit and payment. Never a second row: the single-answer guard and
`hasSubmission` read the same row as before.

**Files.** A new file id in a FILE answer is claimed as at submit (`FormFilesService.attach`, which
checks its uploader); a kept one is not claimed again, so its retention keeps counting from its first
claim. A REPLACED file stays attached to this answer and goes with the existing purge
(`fileRetentionDays`): no orphan, no early deletion.

**What managers see.** `submissions.editedAt` (null until a first change; no history kept) is in the
responses list as "modifiée le <date>" under the answer's date, and in the XLSX export as a "Modifiée
le" column - present when the form allows changes or any row was changed. No notification.

**The codes** (`libs/contracts/form-answers.json`, exported by `answer-bounds.ts`, worded by
`formCodeMessage` on the client): `FORM_ANSWER_EDIT_OFF` (403), `FORM_ANSWER_LOCKED` (409, with
`itemId`), `FORM_ANSWER_NOT_EDITABLE` (409), `FORM_ANSWER_NOT_FOUND` (404); and
`FORM_ANONYMOUS_ANSWER_EDIT` (400) at the form's save.

**Logs**: `[FORM_EDIT]` at entry, at each refusal (with its reason) and at the write (status, files
claimed); the fill page logs under `FormView`.

**Schema**: migration 166 (`166_form_answer_edit.sql`), ADDITIVE and therefore plain (not held):
`forms."allowAnswerEdit" boolean NOT NULL DEFAULT false`, `submissions."editedAt" timestamptz
NULL` and `submissions."priceLockedItemIds" jsonb NULL` (the price snapshot above). Reverse: drop the
three columns (written in the file).

**Tests**: `answer-edit.spec.ts` (the lock rule, the row's own `lines` united with it, and `sameAnswer`), `answerEditGate.test.ts` and `appVersion.test.ts` (the capability gate), `forms.service.public.spec.ts` (an older editor's save keeps the switch), `answer-edit.integration.spec.ts`
against PostgreSQL (CI's `test-social-integration`): an edit done in place, a locked question refused
on a paid answer, pending cash locked too, a full form keeping its seat, a hidden answer dropped, a
closed form, an anonymous form and a switch-off form refused, another person's answer 404, a
cancelled answer, several answers edited separately, file claims, an edit queued behind a cash
validation's row lock, and concurrent cash validations and edits with no lost write.

## The file question (2026-10-15)

A question of type **`file`** asks the member for one file (a CV, a certificate). Unlike every other
attachment in the app, **it is NOT end-to-end encrypted**: the form's managers read it, so the
server must be able to hand it to them. That one fact decides the whole design.

| Step | Where | What holds |
|---|---|---|
| Pick | `FormQuestion.svelte` | PDF, JPEG, PNG or WebP, 8 MiB at most - the per-request budget under the host WAF ([host-waf-body-limit](../../infrastructure/host-waf-body-limit.md)) (`fileQuestion.ts`); checked before upload to say it in the reader's language. A file with an EMPTY `type` (some Android pickers) is judged by its EXTENSION (`pickedFileType`), and `accept` lists the extensions too; **HEIC is refused with its own sentence**, not converted - only Apple's engine decodes it, so a conversion would work on one phone in two |
| Upload | `POST /api/forms/:id/files` (social-service, `FormFilesService.upload`) | the member must be ELIGIBLE to answer (`assertMayUploadAnswerFile`: the form's `submitCondition`, the same audience check as submit); the TYPE is read from the bytes, never from the name or the claimed type; the form must exist, be open, NOT public, and the item must be a file question (an `itemId` over 64 characters is a 400); at most 10 unsent uploads per member per form (429), counted again under a `pg_advisory_xact_lock` on (form, uploader) in the transaction that inserts the row, so twelve parallel uploads keep exactly ten - a loser's blob is taken back. Sent through `fetchUpload` (XHR): the card shows the percentage and offers a cancel, and the page REFUSES to send the answer while any file is still travelling (`form_file_wait_upload`) - an optional file question would otherwise go out empty |
| Store | `POST /media/internal/form-file` (media-service, secret-gated) | retention class `form-file`, the uploader as owner, **no contentType recorded**, an image's EXIF/GPS removed by re-encoding (a PDF is untouched). The STORED size never exceeds 8 MiB - a re-encode can grow a low-quality photo, so the quality steps down - and the manager's download is bounded by that same 8 MiB. An image that does not decode, declares over 40 Mpx, or cannot fit is a 400 "send it as a PDF" - see [media-service](../../services/media-service.md#the-form-file-class-plaintext-read-by-the-server-only-2026-10-15) |
| Submit | `FormsService.submit` -> `FormFilesService.attach` | the answer is the file's id; one `UPDATE ... RETURNING` inside the submission's transaction claims the `form_files` row, matching id, form, question, UPLOADER, not purged, and either unsent within one day or already this submission's. No row = the whole submission is refused. `attachedAt = GREATEST(NOW(), submission.createdAt)`: a pending submission reused later keeps its old `createdAt`, and the retention must count from the claim. A transaction whose `NOW()` was read just before the one-day edge may claim a file the purge is deleting at that instant - benign: the manager's first download reads "Fichier supprimé" and marks the row purged |
| Read | `GET /api/forms/:id/files/:fileId` | `assertFormManager` FIRST, then the bytes from `GET /media/internal/form-file/:id` with their own Content-Type, `Content-Disposition: attachment` (ASCII + RFC 5987 name), `nosniff`, `no-store`. Never through `GET /media/:id`, the push proxy's `GET /media/internal/:id` (no per-object ACL - both refuse the class) nor `/media/public` |
| Purge | `FormFileRetentionScheduler`, hourly at :37 | see below |

**Refused at save**, with the sentence on the save bar (the shared option rule,
`FORM_PUBLIC_FILE` and `FORM_ANONYMOUS_FILE`, on both sides):

- **a public form** (D40): a guest has no account to upload with;
- **an anonymous form**: the `form_files` row and the blob's owner name the uploader, which would
  re-join an anonymous answer to its author (confirmed by the user 2026-10-15; "a file without an
  account" is a future work package);
- **an ANSWER criterion in `submitCondition`** (`assertFileQuestionConfigValid`, and
  `form_file_submit_condition_answer` on the page): the upload is judged on the form's audience
  BEFORE any answer exists, so such a criterion would refuse every upload. A profile criterion
  (promo, formation, cotisation) is known at upload and stays allowed.

**Cancelling an upload is client-side only.** The card aborts the request, but a file the server had
already stored keeps its blob and its unsent `form_files` row until the one-day purge, and that row
holds one of the member's 10 unsent slots meanwhile. Accepted: a member reaching 10 by cancelling
waits a day, which the 429 sentence says.

**The answer reads as a word, never as its id.** `answerText` (and its declared duplicate
`answer-text.ts`) takes the reader's `AnswerWords` - "Fichier" / "Fichier supprimé" - and THROWS on
a file answer without them, so no screen or spreadsheet can print an id by omission. A file is never
a table column (`COLUMN_TYPES`); the responses panel offers a download under the uploader's cleaned
name (`Submission.fileNames`, sent with the list because a native shell cannot read
`Content-Disposition` cross-origin), or "Fichier supprimé" once purged (`deletedFileIds`).

### Retention: `forms.fileRetentionDays` and the purge

`forms.fileRetentionDays` (migration 085, default **7**, CHECK **1..30**) is a row in "Paramètres
avancés", shown only when a question asks for a file. The purge (`purgeOnce`) has two passes, both
drawn ONLY from `form_files` rows - that table is the allowlist; nothing else is a candidate:

1. **Answer files** whose `attachedAt + fileRetentionDays` has passed: blob deleted, then `purgedAt`
   set. The answer stays and reads "Fichier supprimé".
2. **Unsent uploads** older than one day (the attach window is `createdAt > NOW() - 1 day`, the
   purge `<=`, so the two never overlap): blob deleted, then the row deleted.

**ONE clock, the database's.** A run reads `SELECT NOW()` once and passes it as a parameter to both
selections AND to the re-check of each row, and every interval is counted in hours
(`make_interval(hours => 24 * days)`) like the app's own arithmetic. A box clock a few minutes off the
database's would otherwise select a row the re-check calls "not due", an ERROR line every hour.

**Lowering the retention applies at once, without confirmation** (user decision 2026-10-15): the
next run deletes every file already older than the new delay. The settings hint says so.

**The state is the row.** The blob goes first and the row changes only once media-service says the
blob is gone (or was already absent), so a crash in between leaves a row the next run picks up again.
A blob that fails to delete leaves its row untouched, logged, retried next hour; within one run it is
excluded so the run terminates. media-service checks a second allowlist on its side: it deletes only
an object of class `form-file` OWNED by the named uploader, and refuses anything else even when its
id sits in an answer. One log per deleted file and per failure (`[FORM_FILE_GC]`).

**For reuse (bookings):** `purgeExpiredFiles` in `apps/social-service/src/forms/file-retention-purge.ts`
takes each candidate's START date as data (`{ fileId, ownerId, start, retentionDays }`), so a caller
whose clock starts somewhere else - a booking slot's end - passes that instead of `attachedAt`.

## A question's image (2026-11-06)

The owner asked for it on 2026-11-06: *"pouvoir joindre une image a une question, au meme titre
qu'une description"*. Half of it already existed and nobody saw it: an upload route
(`POST /api/forms/:id/items/image`), `items[].imageUrl` and its render in `FormQuestion` - but only
on the EDIT page (the create page had no form id to upload against), as a dashed box below the
description, stored at the 256 px logo bound and cropped to 192 px high. The URL field took any
string, and nothing ever deleted a replaced or removed image.

| Piece | What holds |
|---|---|
| Media path | a PUBLIC asset (`POST media/upload/public`, `size=content`): no session reads it, so a guest on `/f/:id` sees it. Not the encrypted post path - a guest holds no key - and not the avatar route, whose URLs are signed per viewer since phase 1 ([backlog](../../backlog.d/p2-avatar-urls-refuse-unsigned-requests.md)); `/api/media/public/` is unsigned and stays so. Re-encoded to WebP by the media service, EXIF and GPS dropped |
| Size | the device resizes with the post preset (`IMAGE_COMPRESS_PRESETS.post`, 1600 px / 0.85, `questionImage.ts`) and the media service stores it inside 1600 px (`PUBLIC_IMAGE_BOUNDS.content`); a result still over the public route's 2 MiB is refused on the device with its own sentence |
| Stored as | `items[].imageUrl` = `/api/media/public/<uuid>`, the ONLY shape the DTO accepts (`@Matches`, empty string = none), and an optional `items[].imageAlt` (300 characters) |
| Who may cite it | `form_item_images` (migration 136), one row per image: uploaded on an existing form, the row names it; uploaded from the create page (`POST /api/forms/items/image`), the row is UNBOUND and only its uploader's next save may cite it, which binds it. A save citing any other id is a 400 `QUESTION_IMAGE_NOT_YOURS` (`claimForSave`, inside the save's transaction). An id is not a secret: without this a manager could cite another form's image and then have it deleted by removing it |
| Release | when no form cites it any more: the blob through `media/internal/public-asset-delete` (public assets only), then the row - each id in its own transaction under its advisory lock, the citation re-read there (`items @> [{"imageUrl": ...}]`). Called after an edit drops an image and after a form's delete; an ARCHIVED form still cites its images and keeps them |
| Reconciliation | hourly at :19, every row older than 24 h that no form cites: an upload never saved, a form removed with its association, a release that failed |
| Respondent | `FormQuestion` draws it under the label and the help, WHOLE (`object-contain`, at most 384 px high), lazy, its src through the public media base (`associationLogoSrc`, so a native shell reaches the API); alt = `imageAlt`, else "Illustration de la question « label »" - never empty, since the picture is usually what the question is about |
| Editor | "+ Ajouter une image" beside "+ Ajouter une description" on BOTH pages; then a thumbnail, the alt field, "Remplacer l'image" and "Supprimer l'image". The old image is not deleted by the editor: the server releases it when the SAVE leaves no question citing it |

**A duplicated question cites the same image** (same id, same form): it is claimed once, and the
release keeps it while either copy does - asserted in `form-item-images.integration.spec.ts`.

**A booking space's question carries no image**: its questions reuse `FormItemDto`, so they would
take the same URL shape, and a space citing a form's image would lose it with that form - the
citation check reads `forms` only. `assertSettingsValid` refuses an image the edit INTRODUCES (400
`item-image`); one the stored space already holds is kept and logged at WARN, so an older space
still saves its rename. No booking screen uploads one.

**Nor does an association's logo**: `logoUrl` takes our own `/api/media/public/<id>` reference by
hand, so a logo naming a question image would vanish with that form's question. A NEW value whose id
is a row of `form_item_images` - relative or absolute, any host - is a 400
`ASSOCIATION_IMAGE_IS_QUESTION_IMAGE` (`assertNotQuestionImage`, `association-image-url.ts`); a
stored value is kept. No lock is needed: the row is written before the upload's URL is returned.
No client sends a typed `logoUrl`, so no sentence is mapped.

**No backfill**: before 136 `imageUrl` took any string, so a stored value of the public shape may
name an association logo or a form banner pasted into a question. A row is a licence to delete, so
136 writes none; such a form is refused on its next save until the image is removed and uploaded
again (production, read 2026-11-06: no form cites one). Asserted in
`form-item-images.integration.spec.ts`.

**Submissions and exports are unchanged**: an image is part of the question, never of an answer.

## A draft's association may change; a published form's may not (owner, 2026-11-09)

**The report.** *"Dans les formulaires, la sauvegarde auto empeche de modifier le proprietaire du
formulaire (comme l'asso), pas modifiable. Il faut relacher."* The cause was two locks, both written
before drafts existed and both meeting the autosave of 2026-11-08:

- the create page shut its picker the moment the first autosave sent the draft's create
  (`disabled={createSent}`, `routes/forms/create/+page.svelte`), so a builder who typed a title
  before choosing - or changed their mind - could not choose any more;
- the server refused every `associationId` on an edit that differed from the stored one
  (`FormsService.update`, user decision 2026-08-23: "the association link is fixed at creation"),
  so even a revision carrying another association would have been refused at its publication, and
  the editor of a draft showed it read-only.

The 2026-08-23 decision guarded a real thing - MANAGE_FORMS is a right over an association's forms,
so a manager who could cut the link could walk off with a form, and re-pointing it would hand a form
to a third association - but it was written when every form was published at its first save. A
draft has no answer, no payment, no refund, no cotisation granted, no reminder (`/remind` 404s on a
draft) and no post or event naming it (`FORM_IS_DRAFT`): nothing is tied to its link yet.

**The rule (`FormsService.associationAfterEdit`, the only place it is decided):**

| The edit sends | A DRAFT | A PUBLISHED form |
|---|---|---|
| nothing (`associationId` absent) | left as it is | left as it is |
| the stored value (`''` and `null` both mean personal) | no change, no check | no change |
| another association, or none | moved, when the actor holds MANAGE_FORMS in the association it leaves AND in the one it joins (the creation rule, `mayAct`, applied to both sides; a global admin always) - else `403 FORM_ASSOCIATION_NOT_YOURS` | `400 FORM_ASSOCIATION_FIXED`, global admin included |

The id must name an association, for a global admin too: one that is no UUID, or names none
(`forms."associationId"` has no foreign key), is `400 FORM_ASSOCIATION_UNKNOWN` before any
membership is asked. A MOVED draft's cotisation settings are judged on what it carries INTO the new
association - the stored `grantsCotisation`, `cotisationVariantKey`, grid, condition and payment
switch whenever the revision leaves them out - so a granting draft cannot reach another association
without that association's MANAGE_MEMBERS and tier (review of #3198: a revision omitting
`grantsCotisation` carried the stored grant past the check). And a move outside a publication
re-reads the status under the form's row lock in its write: a publication committing between the
edit's checks and its write is refused `FORM_ASSOCIATION_FIXED`, never a published form moved (the
publication itself holds that lock already). The editor of a PUBLISHED form reads its association
from the form, never from a revision naming another.

Both refusals are typed and logged (`[FORMS] draft <id> not moved` / `edit of <id> refused: a
published form stays put`), and a move is logged with both sides and the actor. Membership of the
OLD side is what keeps the walk-off closed: a co-manager through MANAGE_FORMS who is no member may
edit the draft, never take it out (`form-association-move.integration.spec.ts` proves it on
PostgreSQL). Every rule `update` runs after the decision - the grids, the kind that may price, the
payment readiness, the cotisation tiers and who may grant them - reads the association the form
WILL have, never the stored link.

**Why a published form stays put.** What is tied to its association by then: its answers and the
payments routed to that association's collection account (Lydia, refunds from its treasury), the
cotisations it granted (a TIER of that association), its opening reminders, the posts and agenda
events of that association naming it (`assertFormBelongsToAssociation`), the engagement chantier's
openings for followers when they are built (WP-4 `opening_reminders`: an opening is the
association's), and who may read its answers (MANAGE_FORMS of that association). Moving any of these
silently would re-route money and hand answers to people they were not given to; moving them all is
a migration of a form's history, not an edit. The editor shows the association read-only with the
reason and the way out ("créez un nouveau formulaire", `form_association_locked_hint`), and a
refusal reaching it is worded by `draftRefusalMessage`.

**How a draft moves: in its revision, applied at publication.** The association rides in the
autosaved document like every other field - the create page always sends it (`''` for personal:
the revision is an edit, where an absent field means "leave it"), the draft's editor too
(`buildPayload`, drafts only; a published form's payload leaves it out). `publishChanges` applies the
document through `update`, so the move and the publication are ONE transaction: refused, nothing
moves and the revision stays. Until then the draft's ROW keeps the association it was created under,
which is what lists it (`GET /forms`, the association's "Formulaires" tab) and who manages it; the
picker says so when the choice differs ("Le changement d'association prendra effet à la publication
du formulaire", `FormAssociationPicker.svelte`). Writing the row at every autosave was rejected: the
autosave stores a document AS TYPED, with one compare-and-set statement, and an authorization
refusal there would fail every later save of the page until the choice was undone.

**The tier retag follows the revision's association.** A revision naming an association grants
THAT association's tier, so `followRetagInRevisions` matches a revision by the association it will
give the form (`REVISION_ASSOCIATION_SQL`: the document's, else the form's own; compared as text,
since a stored document is unvalidated and one garbage value must not fail the statement).

**The create's replay still names what it was sent with.** The create page remembers the association
its FIRST create named (`createAssociation`) while that create may have landed; its replay - by the
page, or by the background resend from a device copy (`createAssociationId`, `draftResend.ts`) -
names the same one, or the server would refuse it `FORM_CREATE_KEY_REUSED`. The device copy's
document carries the builder's latest choice, which the revision then applies.

**The edit screen of a published form** shows the association as read-only text rather than a
disabled picker - a disabled control suggests someone with more rights could change it, and there is
no such someone.

Tests: `forms.service.draft.spec.ts` ("the association of a draft"), `forms.service.cotisation.spec.ts`
("the association link of a published form is fixed"), `form-association-move.integration.spec.ts`
and `form-draft-revision.integration.spec.ts` (PostgreSQL), `routes/forms/create/page.returnNoRoute`
("the association of a draft being built": changed after the first autosave, two quick edits keep it,
the replay names the sent one), `routes/forms/[id]/edit/page.draft` ("the association").

**The create screen dropped the choice for a free form (fixed 2026-09-19).** `associationId` was
sent to the server only when `requiresPayment` was also true - so picking an association for a
FREE form was accepted by the picker, shown in the summary, and then silently dropped from the
payload: the form saved with no owner, and never appeared in that association's `EditFormsTab`.
Nothing server-side ever required payment for an association to own a form
(`formRequiresStripeReadyAssociation` only gates the STRIPE-readiness check, not whether the field
may be set at all), so the restriction was the create page inventing a rule the API never asked
for. `EditFormsTab` now also carries a "create a form" button
(`/forms/create?association=<id>&returnTo=<back to this tab>`), which is what surfaced it: every
free form created that way would otherwise have vanished from the list that opened it.

## What `/forms` lists

Two sources, merged by id and sorted newest-first: forms the caller owns, and forms linked to an
association where they hold `MANAGE_FORMS`. `assertFormManager` has always accepted that second set,
so those forms were editable and exportable by API while appearing in no list on any screen -
reachable only by someone who already knew the URL.

It was three until 2026-08-26: a per-form co-manager list (`forms.coOwners`) named a third set. It
answered the same question as `MANAGE_FORMS` on a second axis and never agreed with it, so the edit
screen offered the section to association managers whose every click 403'd - `assertFormManager`
admitted them, but only the OWNER could change the list. Migration 053 drops the column; the answer
to "who may manage this form" is now the owner plus the association's form managers, one axis, set
in one place.

Each row therefore says whose form it is, by NAME (`Form.associationName`, resolved server-side;
null for a personal form and for a form whose association has since been deleted). That line used to
print the raw form id, which told a person nothing.

### ONE list for `/forms` and for an association's tab (owner, 2026-11-13)

*"Les interfaces /associations/[slug]/edit/formulaires et /forms sont tres differentes, on ne
pourrait pas homogeneiser tout ca, et avoir le meilleur des deux mondes ?"* They were two products:
`/forms` had six icon-only buttons and the responses accordion; the tab had three text buttons, the
price line, the cash strip and the payments banner. **Both now draw `FormsManagerList`**
(`components/forms/FormsManagerList.svelte`), which carries the UNION. Scope is data, not a fork:

| | `/forms` | the tab (`EditFormsTab`) |
|---|---|---|
| Source (`load`) | `getForms()`: forms the caller owns, plus those of associations where they hold `MANAGE_FORMS` | `listAssociationForms(asso.id)`: `GET /associations/:id/forms` |
| `scoped` | no: each row names its association, or says "Personnel" | yes: the association is implied, the name is omitted |
| Header and "Nouveau formulaire" | the page's `PageHeader`, `/forms/create` | the tab's header, `/forms/create?association=<id>&returnTo=<this tab>` |
| `paymentsReady` | absent (rows span associations): no warning | the association's: a PAID row carries "Paiements non configurees" |
| `notice` snippet | none | the paid-forms banner (it is about the association, so it stays the tab's) |
| Row heading | `h2` (an `h1` above) | `h3` (an `h2` above) |

**The tab's source is the association's route, which returns the WHOLE form.** `GET
/associations/:id/forms` is the authority on which forms belong to it - it also admits a global
admin or a super-admin holding no `MANAGE_FORMS` flag, who are in no `GET /forms` list - and
`listFormsByAssociation` returns the same row `FormsService.list` does (every column, plus
`associationName` and `hasUnpublishedChanges`, archived forms excluded). One read, no per-form
follow-up: a first version read each missing form by id, which was an N+1 where one deleted form
sank the tab, and whose rows lacked the unpublished flag (so a global admin saw no badge and "view"
opened the published page instead of the preview).

**What a row is, everywhere.** The name has the whole width (two lines, `min-w-0`). Under it, the
price ("Gratuit" or the amount, "Paiement sur place accepte") and the states, which read the same in
both places: **Brouillon** (the managers' alone, nobody links it believing it live) and
**Modifications non publiees** on a published form. An archived form (a form with answers that was
deleted) is in neither list: the server's `deletedAt` filter drops it, so there is no archived
badge to draw. Then ONE row of actions, the same at every width:

- **"Modifier" and "Reponses", labelled.** They are what a manager does most; a word costs less
  than guessing a glyph. Under the row's own `md` (a CONTAINER query, `@container`, so the narrow
  settings column and a phone both count) the two share the width equally and the "..." keeps its
  square; from `md` they sit beside the name.
- **Everything else behind one "..."** (`FormRowMenu`: `FloatingSurface` holding `MenuList`, a sheet
  on a phone and a popover on a wide window, the shape of the profile's "..." and the editor's
  menus): the respondent view (the live page, or the preview of a draft or of unpublished edits),
  copy the link, the QR code, the exports, the delete in the error colour. **A draft is offered no
  link and no QR code**, which nobody could open.

*Why this pattern.* Six icon buttons wrapped a phone's row and made every glyph a riddle; three
text buttons crushed the name to a sliver of letters on an iPhone (2026-11-08); two labelled
buttons and a menu fit a 390 px row beside nothing, leave the name its width, and keep every
capability one tap away. The export menu is no longer a second dropdown: its entries (`exportEntries`
in `forms/exportEntries.ts`, workbook plus the two grid CSVs on a priced-grid form) are a section
of the same menu, and `downloadFormExport` is the one place that writes the file.

**Cash awaiting validation: a strip on the tab's rows, the accordion everywhere.** The strip
(validate or cancel a payment, with the same guest naming, `submitterName`, as the responses
screen) is the tab's: one association's forms, a handful of reads. `/forms` spans every association
the caller manages, so a strip there would fire one `pending-cash` read per cash form on every open;
it validates cash in the responses accordion, which holds the same actions (no capability lost).
Validating from the strip re-reads an open accordion, and the accordion's payment actions re-read
the strip (`reloadResponses`).

**Two in-flight guards.** A delete is guarded from the moment its confirmation OPENS (two quick
selections would queue two confirmations and the second delete would 404), and an export disables
the row's "..." with a spinner until the file is written, so a second tap starts no second export.
The empty state draws a create button only when the screen has none of its own (`createHref`): the
tab's header has one.

**A failed read says so** (`common_load_error`) in both places; `/forms` used to render an empty
list for a failed `GET /forms`, which read as "you have no forms".

`/forms?responses=<form id>` (the organiser alert for a payment over capacity) works through the
list, so it opens the accordion on either screen the form is on.

### The responses accordion shows the ANSWERS, and the form decides its own layout (2026-09-20)

The accordion printed four fixed columns - date, name, status, amount - and not one answer, so the
thing a manager opens it for was the thing it did not show. **Nothing was missing from the browser**:
`getSubmissions` has always returned `answers`, and `getForms` returns the whole form, questions
included. The page simply never read them.

A column per question is not the fix either. A form has as many questions as it likes, and three of
the eight types - `long_text`, `multiple_choice`, the two matrices - have no bounded length, so one
paragraph would set the height of every row. **So the layout is derived from the FORM**
(`forms/submissionTable.ts`), not from the viewport and not from a setting:

| | What decides it |
|---|---|
| Becomes a column | `short_text`, `single_choice`, `dropdown`, `linear_scale` - the bounded types - capped at `maxAnswerColumns()` (3 on a paid form, 4 on a free one, measured against the 1024px `tool` width) |
| Never becomes a column | anything conditional (`dependsOn`, `showIf`), whatever its type: it is asked of a subset by construction, so its column is blanks with a few values in it |
| Reads in the row's panel | everything, in the form's own question order |

A form of three short questions therefore lays itself flat; a form of twenty paragraphs keeps its
four columns and puts everything in the panel. Neither needed a decision from anybody.

**The panel lists what the person ANSWERED, not what the form asked.** It is driven by `form.items`
(so a value whose question has since been deleted has no label and is not shown - the export
iterates the items for the same reason) and drops the blanks: a list of what somebody did not say is
longer than the list of what they did.

**The page moved from `reading` to `tool`** (680px -> 1024px). It is the responses TABLE, which
`pageWidth.ts` names as the shape that width exists for, and it is what its own two editor pages
already used. Below `sm` the rows are cards instead: the table overflowed a phone at five columns
before any answer was added to it, and a horizontal scrollbar is not a reading of anything. The two
layouts share every piece through snippets, so the status pill, the panel and the two controls have
one definition each.

### A COLUMN OR A CONTROL THAT CANNOT CARRY INFORMATION IS NOT DRAWN (2026-09-21)

The section above derived the ANSWER columns from the form and left the four fixed ones alone. Two
reports from the user, a day after it shipped, are the same objection applied to what was left:

> *"Pourquoi mettre 'Statut' et 'montant' pour un formulaire gratuit ? Et le fait de mettre a la
> fois un volet pour derouler fait doublon si la reponse est deja sur la ligne."*

**A FREE FORM DRAWS NEITHER STATUS NOR AMOUNT.** When `requiresPayment` is false every status reads
`free` and every amount reads `-`, down the whole table - two columns of one repeated value, costing
about 180px each out of the 1024 the page has. `requiresPayment` is not a new notion: it is the one
predicate `summary.ts` already reads to print the free label, and the one `itemsPayload.ts` zeroes
every price modifier on. **It is passed from the page, never inferred from the submissions** - a paid
form whose responses are all still `pending` would infer as free, and a column must not appear the
day somebody finally pays.

The freed width is not left blank: `maxAnswerColumns(false)` is **4**, so a free form draws one more
question than a paid one. That is the same rule as the cap itself - a column is worth its width or it
is not drawn.

**AND A CHEVRON THAT OPENS A PANEL HOLDING NOTHING NEW IS A CONTROL A READER MUST CLICK TO DISCOVER
IT WAS POINTLESS.** The redundancy the report names is not "inline answer AND panel" - for a form
whose purpose is comparing proposals across rows, the inline answer is the scannable thing, and
removing it would mean opening every row to read a table. What is redundant is the CONTROL, on the
rows where it adds nothing. So `panelAddsNothing(answered, columns, isClipped)` disables it when:

- every question this person answered is already a column, **and**
- every one of those cells is showing its answer IN FULL.

A form of one short question therefore loses its chevron on every row, which is the outcome the
report asked for; one paragraph, one conditional question or one clipped answer brings it back on the
rows that have one, which a blanket removal would not have. **The predicate is asked with the columns
the CALLER draws, never with the ones the form would allow** - the card layout below `sm` draws no
answer column at all, so it passes an empty list and keeps its control wherever there is an answer.
The control is disabled rather than removed, so the columns of a table whose rows differ still line
up under their headers.

#### The second half of that report: what "fits its cell" is, and who is allowed to say it (2026-09-22)

The first implementation answered it with a constant - `COLUMN_CELL_CHARS = 25`, `max-w-48` less its
gutter divided by an average glyph at `text-sm` - and the user came back with the obvious question:

> *"pourquoi certaines lignes sont depliables et d'autres non ?"*

**There is no character count that is right, because whether a string fits a box is a fact about a
font, a zoom level and a browser.** Two answers of the same length land on either side of any
threshold, so the table showed a reader rows that expanded next to rows that did not with no visible
rule between them. `reportClipped` replaces it with the browser's own answer, `scrollWidth >
clientWidth`, reported by each cell through a `ResizeObserver` into a `SvelteSet` the control reads.
It re-measures on mount, on resize **and on text change**, the last because a clipped element's
border box does NOT move when its content does.

**AND THE CELL WAS NEVER ACTUALLY BOUNDED.** `max-w-48` on a `<td>` is a *suggestion* under auto
table layout: the browser widens the cell to fit its content anyway, so `truncate` never fired, the
answer was fully visible on the row, and the panel repeated it word for word - the same doublon the
report opened, one step removed. The width now lives on a `<div>` inside the cell, where `max-width`
is honoured, which is also what makes the measurement mean anything.

The lesson generalises past this table: **a threshold that stands in for a measurement the platform
will make for you is a guess, and it is a guess a user meets before you do.**

The colspan is the case neither file shows on its own: it is a number written beside a header list
that now has two lengths, and a short one leaves the panel ending mid-table. `answers.svelte.test.ts`
asserts it equals the rendered header count on both.

### The sheet is named after the title, made acceptable to Excel (2026-11-13)

ExcelJS THROWS at `addWorksheet` on `* ? : \ / [ ]`, a quote at either end, an empty name or
`History`, so a form titled "Service ... 19/11" made every export of it a 500 in production.
`safeWorksheetName` (`apps/social-service/src/utils/worksheet-name.ts`) turns a refused character
into `-`, cuts at 31 characters and trims after the cut; the form and booking exports both call it.

### THE XLSX IS WRITTEN IN WORDS THE SERVER DOES NOT HAVE (2026-09-22)

The same report that asked about the chevrons carried a second half:

> *"Au niveau de l'export excel, les en-tetes sont en anglais et Amount Paid et Status apparaissent
> quand meme sur un formulaire gratuit."*

Both are the same defect seen twice: **the export was built where none of the decisions live.**
`FormsService.exportSubmissions` runs in a NestJS service with no Paraglide, no locale and no request
language it could trust, so it wrote its own English - `Timestamp`, `First name`, `Amount paid` - and
the raw `free` enum into the status column, into a file a French manager opens. And it had never been
told about `requiresPayment`, so the two columns the table had just learned to drop were still there,
one repeated value down the whole sheet.

**THE FIX IS NOT A TRANSLATION TABLE ON THE SERVER. It is that the server owns no word at all.** The
client sends `ExportLabels` - the five fixed headers and every payment status label it knows - as a
URL-encoded JSON query parameter, built by `exportLabels()` from Paraglide. `parseExportLabels`
validates it at the boundary and **refuses when it is absent or incomplete**: there is no default,
because the only thing this side could substitute is the English that was the defect, and a silent
fallback ships a wrong file that looks right. A status the client had no word for is written AS
STORED and logged at `warn` - the row is telling the truth about itself, and a blank would hide the
one case worth seeing.

The free/paid rule is now the same predicate on both sides, `requiresPayment`, the one `summary.ts`
reads and the one `itemsPayload.ts` zeroes every price modifier on. `forms.service.export.spec.ts`
asserts it by **parsing the workbook back** rather than by reading a header constant, and
`export-labels.spec.ts` covers every way the parameter can be wrong.

The payment status labels themselves moved out of `FormSubmissionsTable.svelte` into
`frontend/src/lib/forms/paymentStatus.ts` on the same day, for the reason the duplicate reader below
exists: the screen and the file answer one question, and a second copy of the mapping is one added
status away from them disagreeing about the same row.

### Configurations the API refuses

`FormsService.assertCotisationConfigValid` runs on create AND update, and rejects every setting that
would look saved and then do nothing:

- a grant with no beneficiary association, or a price grid divided on a cotisation tier without one;
- a grant on a form that does not require payment — a zero-total submission is stored `free` and
  never reaches `markPaid`, so the grant could not fire;
- either of those on an association with no cotisation;
- a `variantKey` the association does not sell;
- a base-tier grant on an association that sells named tiers only.

A file question is refused on a public or an anonymous form, and `fileRetentionDays` outside 1..30
([the file question](#the-file-question-2026-10-15)).

## Sharing a form: the link, and the same link as a QR code

Both the list's "..." menu (`FormRowMenu`) and the detail screen offer two entries: copy the public
link, and show it as a QR code. The modal (`shared/QrCodeModal.svelte`) knows nothing about forms - the caller hands
it an already absolute URL (`publicAppUrl`), the label the plate and the file name are built from, an
optional owner line, and the sentence saying what scanning it opens. That is what lets whatever comes
next reuse it without a prop naming a feature.

The PNG is rendered ONCE per opening and the preview `<img>` and the download read that SAME blob, so
what a person sees is byte-for-byte what they save. `downloadDecryptedFile` does the saving, as
everywhere else in the app.

### The style is measured, not decorated

`utils/qrCode.ts` does not use `qrcode`'s renderer: it takes the raw module matrix at error
correction `H` and paints it on a canvas sized FROM an integer module pixel size, so the grid never
lands between pixels. Modules are CONNECTED strokes with rounded corners, never isolated dots - a
corner is rounded only where both modules sharing it are light (`moduleCorners`), and the whole grid
is accumulated into ONE path and filled once, so no antialiased seam splits a stroke. The three
finders are stacked rounded squares, the ink is a diagonal gradient between two DARK brand colours,
and the colours are fixed dark-on-light: a QR inverted by a theme is a QR a phone refuses.

Isolated dots were tried first and measured, by decoding the actually painted pixels in a browser
across seven sizes: a 0.84 dot fill decoded 6 times out of 14 combinations against 12 out of 14 for
connected strokes. Adaptive binarisation is the reason - a scanner thresholds a neighbourhood, and a
dot leaves it less dark to find. The look that was asked for and the look that decodes were the same
look. The one remaining failure, a long URL under 160px, is a pure resolution limit: the BARE square
symbol fails at the same threshold, so neither the style nor the badge costs anything there.

The bird sits in a rounded badge over the middle at 22 percent of the side, which
`logoBadgeDamageRatio` keeps under a tenth of the symbol - well inside the 30 percent `H` recovers,
asserted at all 40 versions.

### The plate carries the name

An exported code is read off a poster, where a bare grid says nothing about what it opens. So the PNG
is a taller white plate: the code, then the form title in Fredoka and, when the form belongs to one,
the association name in Nunito - the app's own two faces in its own two text colours. The title wraps
to two lines and then ellipsises. `document.fonts.load` is awaited before drawing, or the canvas
falls back to a system face without saying so. The file lands as `canari-qr-<slug>.png`.

### It encodes the ordinary URL, so the deep link is the app's, not the code's

There is no scheme of our own in the payload: it is the same `https://canari-emse.fr/forms/<id>` the
copy button hands out, which the Android manifest claims with an `autoVerify` intent-filter
(`pathPrefix="/forms/"`) backed by `/.well-known/assetlinks.json`. A scan that lands in a browser
rather than in the app therefore says something about App Link verification on that device, never
about the code - `adb shell pm get-app-links fr.emse.canari` is what settles it, and a scanner that
renders the page in its own webview never consults the resolver at all.

## Note on form management

Association admins reach the same list, scoped to their association, through the associations
module (`edit/EditFormsTab.svelte`, [one list](#one-list-for-forms-and-for-an-associations-tab-owner-2026-11-13)).
Building and configuring a form happens in the two admin routes above.

## Tests

`apps/social-service/src/forms/forms.service.cotisation.spec.ts` (the config refusals, the
`MANAGE_MEMBERS` gate, link immutability, granting on payment) and `forms.service.list.spec.ts` (both
sources, dedup, ordering, naming). The unified list is tested in `FormsManagerList.svelte.test.ts`
(the row, both scopes, the menu, the responses link, cash), `EditFormsTab.svelte.test.ts` (what is
the tab's own) and `associations.service.list-forms.spec.ts` (its source). The forms module had no test at all before 2026-08-23.

The matrix carries its own: `pricing/audience.spec.ts` (`matchesCondition`, every criterion shape),
`pricing/price-matrix.spec.ts` (cell resolution, the `others` bucket, completeness), `validate.ts`'s
refusals through `forms.service.matrix.spec.ts` (an incomplete grid, a double-counted question, a
condition with no criterion), `forms/visibility.spec.ts` (memoisation, cycles, the legacy pair
ANDed with `showIf`) and `frontend/src/lib/pricing/priceMatrix.test.ts` (the cross product and the
payload). What the boutique does with the same grid is covered by `products.service.spec.ts` - see
[cotisations](../../cotisations.md#a-product-prices-on-the-same-grid-a-form-does).

**The reading of a stored answer is a DECLARED DUPLICATE**, and the two suites over it are why.
`frontend/src/lib/forms/answerText.ts` and `apps/social-service/src/forms/answer-text.ts` are the
same file byte for byte, declared in `.github/scripts/lib/declared-duplicates.mjs` so a gate refuses
them drifting; `answerText.test.ts` and `answer-text.spec.ts` assert the same cases on each side.
They answer ONE question - what did this person answer - asked by the responses table and by the
XLSX an hour later, and those two must not be able to disagree. The copy exists because there is no
TS library between `frontend/` and `apps/` ([libs](../../libs.md)). `submissionTable.test.ts` covers
which questions become columns, and `FormSubmissionsTable.answers.svelte.test.ts` mounts the
component for the part neither file can prove: that a column arrives as a header AND a cell, that the
panel is shut until opened, and that its `colspan` still spans the whole header.

The file question has its own suites: `form-files.service.spec.ts` (every upload refusal - wrong
type read from the bytes, too big, closed/public form, not a file question, too many pending - the
ownership statement at submit, the download's 404/410), `forms.service.file.spec.ts` (refused at
save on a public or anonymous form, attached inside the submit transaction, the manager list),
`forms.controller.files.spec.ts` (a non-manager download refused before any byte is read; the
headers), `form-file-retention.scheduler.spec.ts` (a stateful fake database and media service: the
purge run twice, a blob that fails, a file of another class whose id sits in an answer left alone),
and media-service's `media.service.form-file.spec.ts` (the class refused on every client route and
by `DELETE /media/:id`, the purge allowlist, EXIF/ICC stripped with the orientation applied, a PDF
byte-identical). Front: `fileQuestion.test.ts` (empty type, HEIC), `FormQuestion.svelte.test.ts`
(progress, cancel, the busy signal), and the file cases of `answerText.test.ts` and
`FormSubmissionsTable.answers.svelte.test.ts`.

**What a mock cannot prove runs on a real Postgres**: `form-files.integration.spec.ts` applies
migration 085 to a throwaway schema and drives the real service and scheduler - a claim past the
window, by another uploader, of a purged row, from another form, two submissions racing for one
file (exactly one wins), `attachedAt` on a reused submission, twelve parallel uploads (exactly ten
kept), the purge run twice and a lowered retention. It is the ONLY test guarding the `GREATEST(...)`
on `attachedAt`, the advisory lock and the claim SQL as Postgres executes it, and **it runs in CI on
every pull request touching social-service** (`test-social-integration`, against production's
PostgreSQL, failing on any skipped test - [cicd](../../cicd.md#package-1-opening-a-pull-request-ciyml)).
Locally:

```sh
docker run -d --rm --name formfiles-pg -e POSTGRES_PASSWORD=it -p 55432:5432 postgres:18-alpine
cd apps/social-service && SOCIAL_IT_DATABASE_URL=postgres://postgres:it@localhost:55432/postgres \
  bun run test -- src/forms/form-files.integration.spec.ts
```

`frontend/src/lib/utils/qrCode.test.ts` answers the QR claim on PIXELS rather than on the badge's
arithmetic: it rasterises a symbol in pure JS through the SAME exported geometry the canvas draws
(`moduleCorners`, `moduleContains`, `finderShapes`, `badgeShape`) and hands the buffer to `jsQR`, a
real decoder that knows nothing about how the image was made - with no badge, with it, and on a link
far longer than a form URL. happy-dom has no 2D context, which is why the canvas itself is not under
test and the geometry is exported instead of inlined: a retuned radius moves the test with it.

## The paid half: what it needs, scoped 2026-09-30

Found while scoping it, so it is not re-derived (Lydia is live in production since 2026-11-06, [backlog](../../backlog.d/wp-lydia-1-lydia-live-in-production-with-one-payment-observed-end-to-end.md); the paid half itself is its own work packages):

- **The payer's e-mail IS Lydia's `payerRecipient`** - the Lydia payer-address blocker resolves itself for a
  guest form, since the guest types an e-mail. It does not for a logged-in boutique purchase.
- **`social-service` calls `core-service`'s `create-checkout-session` WITH the shared internal
  secret** (`internalCoreRequestConfig()`, `apps/social-service/src/internal/core-request.ts`), and
  the route has accepted it since 2026-10-07 (`apps/core-service/src/payment/payment.controller.ts`
  documents the 401 it used to answer). This line said "no credential" until 2026-10-15, which was
  stale. A guest needs no `X-User-Id` for the checkout itself; what is still NOT verified is one
  observed paid form on dev.
- **Fulfilment works without a `userId`** since WP-P1: the purchase record takes NULL and the
  cotisation grant is skipped (and refused at save).
- The scope widened on 2026-10-15 (PP1): price, ANSWER grid, supplements and cash; never a grid on
  the profile nor a grant.

## Four defects found on dev v1.1.2-alpha.2 (2026-10-07)

- **Deleted form = `404`, not an empty `200`.** `FormsService.get` returned `null` and Nest sent a
  `200` with no body, which `getForm` could only call "Empty response from server" in raw English.
  It now throws `NotFoundException`; `getForm` throws the typed `FormNotFoundError` on a 404 and the
  view and edit pages render `form_view_not_found` (Paraglide).
- **A global admin who is not a member** arrived from an association's Formulaires tab with no
  selector (the builder lists MEMBERSHIPS) and a preselected id that matched nothing.
  `lib/associations/requestedAssociation.ts` fetches the requested association when the memberships
  lack it; the server stays the authority (it lets a global admin create for any association).
- **A paid form's refusal reason** now carries the same "Le prestataire de paiement a refuse ce
  paiement" sentence as the shop toast: `submitForm` throws a `SocialApiError` (typed `code`), and
  `providerRefusalMessage` (`lib/associations/paymentRefusal.ts`) words it for both surfaces.
- **No Stripe copy anywhere in the form UI (2026-10-07, user: only Lydia "Paiement Canari" and
  cash).** `lib/associations/paymentProviderCopy.ts` `onlinePaymentCopy`: the form editor shows ONE
  non-selectable online line ("Paiement Canari", paid on Lydia's secure page) and the cash toggle.
  A leftover `stripe` or `disabled` provider shows an explicit "unavailable" line, an unknown one a
  neutral line without description - never a default. Saved cards stay Stripe-only via
  `supportsSavedCards` until the backend batch (see [payments](payments.md)).

## A form with submissions is archived, never removed (2026-10-11)

`submissions.formId` had no foreign key, so deleting a form orphaned its submissions (29 on prod and dev, 5 paid: the payers' records, nameless). Migration 081 adds `forms."deletedAt"` and `submissions_form_fk` (`ON DELETE RESTRICT`, never CASCADE: a cascade would delete paid rows). No tombstone rows exist.

- **One removal path**, `retireForms(manager, { formId } | { associationId })` in `apps/social-service/src/forms/retire-forms.ts`: a correlated `EXISTS` on `submissions` decides per form - archive (`deletedAt = now()`) when it holds any, hard delete when it holds none. `FormsService.delete` and the association delete (inside its one transaction) both call it; a bare `remove` or `manager.delete(Form, ...)` would now be refused by the key.
- **Respondents and lists never see an archived form**: `list` (admin, owned, association scan), `get`, `getPublic`, `submit` (member and guest), `hasSubmission` and `subscribeReminder` filter `deletedAt IS NULL` and answer 404 / no right to submit.
- **Staff still do**: `assertFormManager` and `getSubmissions` do not filter, so an archived form's submissions stay readable by id (owner, global admin, MANAGE_FORMS of the association). An archived form keeps its `associationId`; deleting the association archives rather than detaches it, and it appears in no list, so it cannot show as "Personnel".
- **The migration refuses to run while orphans exist**: it RAISES with their count, so it cannot deploy before the data is cleaned. The 29 orphans were backed up and deleted on both estates on 2026-10-11, and the migration shipped in `v1.2.4` (first on dev in `v1.2.4-alpha.1`). It is idempotent (`IF NOT EXISTS`, a `pg_constraint` check).
- **Every call was a SQL syntax error from `v1.2.4` to its fix (found 2026-10-19)**: TypeORM's `getQuery()` returns a bare `SELECT ...`, so `EXISTS ${sub}` produced `EXISTS SELECT ...`. Form deletes and association deletes both failed. The unit spec's mock returned the parentheses itself, so it passed; the spec now mocks the bare string, and `retire-forms.integration.spec.ts` runs it against PostgreSQL.
- **Still owed (carried over when the backlog entry was closed, 2026-10-18)**: an integration run of migration 081 on a real database (none was reachable when it was written), and the purchase-history name of a paid submission of an archived form (the form row still exists, so it is nameable; not exercised).


## An online payment holds its seat for 30 minutes, and a late one is decided from the row (2026-10-15)

Measured on `main` before this: `submit` counted `pending` toward `maxSubmissions` and nothing ever released it, so an abandoned checkout kept its seat for ever (cash had its own expiry, `expireStalecashPayments`). Decisions PP3 and PP4 of the paid public forms chantier (`public-paid-forms-chantier.md`, planning), for ALL forms, then D1-D3 (user, 2026-10-15) after the adversarial review.

- **The hold is read from the row.** `apps/social-service/src/forms/seat-hold.ts` holds the one constant (`PENDING_PAYMENT_HOLD_SECONDS`, 30 min, from which the Lydia request's shorter lifetime is derived, D1 below) and the one SQL fragment (`PENDING_HOLD_CUTOFF_SQL`, on the DATABASE clock: the column is a `timestamp` written by the database's `now()`, and the service process does not run in the same zone - measured +2 h against a UTC session). The hold counts from **`paymentRequestedAt`** (migration 084), the instant the row's CURRENT payment request was issued, not from `createdAt`: `submit` reuses a live pending row and issues a new request, and the hold restarts with it. `seatHoldingWhere` counts `paid`, `free`, `pending_cash` and a `pending` younger than the hold; the seat count, `get`, `getPublic`, `hasSubmission` and the reuse in `submit` all read it, so a seat is free the moment the hold passes, whether or not any job ran.
- **A retry is not a new answer.** `submit` looks the person's live pending row up BEFORE the capacity check: it already holds their seat, so a retry on a form it filled is reused instead of being refused as "Form is full" (which it was on `main`).
- **The job only makes the row say it.** `FormReminderScheduler.expireStalePendingPayments` (every 5 min, a `running` flag against self-overlap) first reads at Lydia every `pending` row whose request has ended and settles it on a verified answer (the reconciliation sweep, [lydia-api](../../lydia-api.md#7-reconciliation---the-sweep-lydias-documentation-asks-for)), then moves what is left `pending` past the hold to `expired` - both by ONE hold cutoff read from the database clock at the start of the tick (`pendingHoldCutoff`), so no row is expired that the read did not select - never a delete, the row is the trace a late payment is matched against. Its `WHERE` names the only state it leaves, so a second run moves nothing. `paymentMethod` tells an online `expired` (null) from a cash one (`cash`).
- **A late payment (`markPaid`) is decided under the form's row lock** (`lockFormSeats`, `SELECT ... FOR UPDATE` on `forms`, READ COMMITTED). A row still holding its seat becomes `paid`; one that holds none (`expired`, `cancelled`, `pending` past the hold) becomes `paid` while the cap has room, else **`paid_over_capacity`**, logged at WARN with the submission, the form and the amount. It grants no cotisation (no seat was given) but keeps its purchase record (the payer's trace). It is refunded from Canari like any confirmed form payment ([payments](payments.md#refunds-from-canari-enrolment-lot-4)): a total refund turns it `refunded`.
- **What a payment buys runs from durable flags.** The cotisation grant and the purchase record run after the payment's commit; `cotisationGrantedAt` and `purchaseRecordedAt` (migration 084) are CLAIMED by a conditional `UPDATE` only one caller can win, and released if the effect failed. A replay of the same payment (a repeated Lydia callback, or the callback and the payer's return - `confirmPayment` - both landing in `markPaid`) finishes only what is still NULL: before this, each call re-granted and wrote another purchase record, and a failed grant was lost for good. The migration sets both flags on every row already `paid`, because the old code ran both effects on every call.
- **The row names its current request by BOTH of Lydia's ids.** `request/do` answers a numeric `request_id` (what the callbacks and `request/cancel` carry) and a `request_uuid` (what `request/state` and the return URL carry), measured on the sandbox 2026-10-15 ([payments](payments.md)). `submit` stores the first in **`paymentRequestId`** (migration 084) and the second in `stripeSessionId`, by named-column `UPDATE`: the whole-entity `save` it replaced wrote the pre-transaction `paymentRequestedAt` back and silently undid the hold restart of a reuse (measured on Postgres 18).
- **`markPaid` never decides by id, but accuses a foreign one.** One payment can reach it under TWO ids (the callback's `request_id`, `confirmPayment`'s `request_uuid`), and the row now stores BOTH, so idempotence still comes from the row alone (a settled status is a no-op, the two flags) and a replay by either id is silent. The id that settled the row goes in **`paymentSettledBy`** (migration 084) and `stripeSessionId` is no longer overwritten. A confirmation on a settled row naming NEITHER stored id is a second request paid for one answer: logged at ERROR with both sides, status unchanged (the money landed; refusing would hide it). A row written before 084 names only its uuid, so its own callback's numeric id is not accused.
- **One answer per person, at submit (2026-10-21).** A submit after a PAID answer on a single-answer form inserted a new row and issued a new `request/do`, and a second paid purchase was recorded for one answer. `submit` now reads the person's rows UNDER THE FORM LOCK (`answerHoldingWhere`: every seat-holding row plus `paid_over_capacity`) and refuses ANY such row other than the live pending one it reuses - every row is read, not the newest, so an older paid answer behind a newer pending one still refuses (review of #2215) - with **409 `ALREADY_ANSWERED`** (Paraglide `form_already_answered` via `paymentRefusal.ts`) before anything is issued: it is checked FIRST, before the settle that would cancel a pending request at Lydia, and again under the lock. `hasSubmission` reads the same predicate, so the page shows such an answer as answered - and, reading every such row as the guard does, shows the most decided one (`pickShownAnswer`: paid or paid over capacity, then free or cash, an online `pending` last), so a legacy older paid row behind a newer pending one no longer shows "pending" with a retry the server refuses. Logged at INFO: a second tab or a back button is expected, not an accusation. A `cancelled` or `expired` row (declined, cancelled or expired request) is no answer, so the retry after it goes on. Anonymous forms keep their registry, guests and multiple-answer forms are untouched. Tests in `forms.service.seat-hold.spec.ts`. Controls, each run by deleting the check: the lock-held check alone fails one test, two simultaneous FREE answers by the same person (both pass the early check before either row exists, and only the check under the lock stops the second insert); the early check alone fails two, an older paid answer behind a live pending row (the lock-held check still refuses, but only after the settle has cancelled the request at Lydia); both together fail seven; the newest row picked again in `hasSubmission` fails three.
- **One answer per person, also for a late payment.** On a single-answer form, a late payment whose payer already has another row holding a seat or paid lands `paid_over_capacity`, logged at ERROR: never a silent second `paid`.
- **Two decisions of the lead session, 2026-10-22 (decided as lead, not by the user's own word).** (1) A refund done OUTSIDE the app, or a manager deleting a paid answer, does NOT free the single-answer slot: `ALREADY_ANSWERED` stays. A TOTAL refund through Canari (enrolment lot 4, [payments](payments.md#refunds-from-canari-enrolment-lot-4)) does: it turns the answer `refunded` under the form lock, which no longer holds a seat nor counts as an answer. (2) A person holding a `pending_cash` answer who then submits online stays REFUSED; a manager converts or cancels the cash answer first.
- **`cancel-pending` applies only to the row's CURRENT request.** core-service names the request it reports (the callback's `requestId`), and `cancelPendingSubmission` compares it to the stored id under the row lock: another id leaves the row as is, logged, and a report naming none is refused. A row with no stored id matches no report and leaves `pending` through the expiry job. Since #1910 (merged 2026-10-15) the multipart callbacks are parsed, so every cancel or expiry is reported; the comparison and the settled-row no-op are what make that safe. **And the report is a trigger, never the verdict (2026-10-18):** a current, payee-matching report then reads the row's `request_uuid` at Lydia (`settleFromProvider`), and only `declined` or `cancelled-or-expired` (`SETTLED_REFUSED_REQUEST_STATES`) releases the seat - under the lock, while the row still names the uuid read; `paid` records the payment; `open`, an unmeasured state or a failed read keeps the seat (`unreadable` is core's retryable 503) ([payments](payments.md#what-confirms-a-payment-2026-10-16)).
- **What confirms a payment: the callback, and the payer's return when the callback has not (2026-10-15).** It was claimed here that "every payment reaches `markPaid` twice", the callback and `verify-session`. **False, measured on the sandbox** ([payments](payments.md#what-requeststate-answers-and-what-it-does-not-2026-10-15)): `verify-session` took the submission from the `order_ref` it expected `request/state` to echo, and no variant of that call echoes it, so it could never name a submission; and no page reached it anyway, since Lydia does not fill `{CHECKOUT_SESSION_ID}` and the return URL carries `submission_id` instead. The callback was the ONLY confirmation, and a payment whose callback was lost stayed `pending` until the job expired it. `verify-session`, `cancel-session` and `retrieveSession` are deleted. **`POST forms/submissions/:id/confirm-payment`** (submitter or manager) replaces them: on a `pending` row - and on an `expired` or `cancelled` one that names a request, since a payment made at the end of the hold whose callback is lost leaves the row released with no seat (`CONFIRMABLE_PAYMENT_STATUSES`) - it reads the row's OWN `request_uuid` through core-service `payments/request-state` with the Business's vendor token and, on `paid`, calls `markPaid` with that uuid, which decides it like any late payment (`paid` while the form has room, else `paid_over_capacity`) and re-checks UNDER THE ROW LOCK that the row still names the uuid read (`onlyIfRowNames`: a retry that replaced it settled it itself, so nothing is written, at WARN); on `declined` (the payer refused, state 5) or `cancelled-or-expired` (6) it RELEASES a `pending` row to `cancelled` under the row lock, only while the row still names that uuid (`releaseSettledRefusedRow`), so the payer may retry at once (see [a declined payment](#a-declined-payment-releases-the-answer-2026-10-21)); `open` and `unknown` answer the row unchanged, a failed read at WARN. A row whose id is not a Lydia uuid (32 hex digits, `LYDIA_REQUEST_UUID_RE`) - a Stripe-era `cs_...` - is not asked about at all, one INFO line, since core would refuse it with a 400 on every poll. It is throttled per user and submission (`UserResourceThrottlerGuard`, `CONFIRM_PAYMENT_PER_MINUTE` = 12, above the return page's 10-read poll), since each call spends the platform's tokens on Lydia; a 429 ends the poll on "awaiting confirmation". `1 = paid` and `5 = declined` were measured on dev on 2026-10-21 ([payments](payments.md#what-requeststate-answers-and-what-it-does-not-2026-10-15)). The success page polls it instead of the plain read, so a payment reaches `markPaid` once (callback, or return) or twice (both, in either order). Nothing comes from the client but the submission id it may already read - unlike the public `mark-paid` deleted on 2026-08-22. The same measurement found `payments/request-state` refusing every real request: it validated the uuid as the dashed RFC 4122 shape, and Lydia issues 32 hex digits with no dash, so every settle that reached the state read (D2 below) answered 409 on `main` from #1906 until this fix, before any release carried it. Fixed (`SESSION_ID_RE`), with a test that fails on the old shape.
- **What confirms a payment since 2026-10-16: Lydia's answer about the row's OWN request, on either trigger.** The callback is verified with the Business private token of the association that owns the payment, over every received field but `sig` (measured on the sandbox), and is then only a TRIGGER: `provider-confirm` checks the verifying Business is the one the row's request was ISSUED to (`lydiaVendorToken`, never the payee resolved now, so a list's delegation revoked or moved meanwhile loses nothing - [payments](payments.md#who-refunds-a-delegates-payment-the-account-that-took-it-owner-review-of-2967-2026-11-03); an authentic callback of one association never settles another's row) and runs the same `settleFromProvider` read as `confirm-payment` - `markPaid` only on Lydia's `paid`, never on the callback's word or amount. An association with NO key stored has its callbacks refused (one 400, the same as a bad signature) and its form payments confirmed only on the payer's return - the designed state, shown in the Lydia panel as "callbacks cannot be verified yet" until a payout manager enters the key. Mechanism, key storage and the boutique gap: [payments](payments.md#what-confirms-a-payment-2026-10-16).
- **The cancel page tells the payer what happened.** It reads the row first and shows a payment the callback already confirmed as paid (or over capacity), never as cancelled; a cancel that found the request PAID at Lydia (`alreadyPaid`) shows the same; the 409 `PREVIOUS_PAYMENT_OPEN` is an answer, shown with its own title and `form_previous_payment_open`, logged at info rather than as an error; anything else says the cancel is not confirmed and when the answer is released. `paymentCancelView` in `paymentReturn.ts` is the one mapping.
- **Every status move is one locked step.** `submit` takes the form lock too (its REPEATABLE READ transaction prevented neither race its comment named: measured on Postgres 18, four concurrent submits on a 1-seat form took 4 seats on `main`, 1 now). `cancelPendingSubmission`, `validateCashPayment` and `cancelCashPayment` go through `moveLockedSubmission` (row lock, check, write), so a cancel or expiry callback of an old request cannot overwrite a `paid` committed in between.
- **The manager sees it first.** `getSubmissions` and the XLSX put `paid_over_capacity` rows on top (`overCapacityFirst`); `frontend/src/lib/forms/paymentStatus.ts` labels both new words (the XLSX takes them from the client, as above) and colours an over-capacity pill as refused, not settled. The return page (`paymentReturn.ts`) keeps waiting on `expired` (a late payment may still land) and says "payment received, form full" on `paid_over_capacity` - it says the payment is at the top of the organiser's responses and to contact them about a refund, and promises neither a notification (D3) nor a refund, which stays the organiser's decision (made from the Achats tab).

### A declined payment releases the answer (2026-10-21)

Measured on dev (sandbox): a payer who DECLINES on Lydia's page leaves the request in state `5`, Lydia sends **no callback** and shows its own error page with **no link back**. core-service read `5` as an unmeasured `other`, so the answer stayed `pending` and a retry answered 409 `PREVIOUS_PAYMENT_OPEN` for up to 30 minutes, with no button on the form.

- **The state is a TYPE, classified once at the provider boundary**: `CheckoutRequestStateKind` (`payment-provider.interface.ts`) is `open | paid | declined | cancelled-or-expired | unknown`, from `LYDIA_REQUEST_STATES` (`lydia-payment-provider.ts`: 0 / 1 / 5 / 6). `unknown` - any other code, logged at WARN - is never paid and never settled. social-service reads the wire value through `toRequestState` (`seat-hold.ts`); a word it does not know (an older core's `closed` mid-deploy) is `unknown` too, so a deploy in either order refuses rather than releases.
- **`declined` and `cancelled-or-expired` are `SETTLED_REFUSED_REQUEST_STATES`**: a retry's settle frees the row on them, and `confirmPayment` releases a `pending` row to `cancelled` on them. `confirmPayment` answers `requestState` (the typed state read on that call), from which `paymentReturnVerdict` (`paymentReturn.ts`) derives `declined` / `ended`: the success page says so (`form_success_declined_*`, `form_success_ended_*`) with a retry link.
- **The form page asks once on load.** `GET forms/:id/check` now answers the caller's own `submissionId`; when it is `pending` the page calls `confirm-payment` once, and on a dead request it re-enables the pay button (the retry) with `form_view_payment_declined_note` / `form_view_payment_ended_note`. The same mechanism covers an expired or cancelled request whose callback was lost (state 6 while the row still reads `pending`).
- **A stale state is never answered** (review of #2210): a retry may replace the request between `confirmPayment`'s read and its answer (two tabs, the success page polling while the payer retries). `requestState` is answered only while the row still names the uuid that was read, and the client never derives `declined` / `ended` from a row still `pending`: either would offer a retry that cancels the request being paid.
- **Not covered**: an answer whose request is still `open` (the payer closed the tab) keeps "pending" with no button until the hold ends - the server would cancel and reissue on a retry, but the page offers none ([backlog](../../backlog.d/p2-an-answer-whose-lydia-request-is-still-open-shows-pending-with-no-button-for.md)).

### The native payer's return: read on resume, and an https return on Android (2026-11-13)

**What broke (owner, production, Android store app 1.6.10).** "Payer" opened Lydia's payer page in the phone's DEFAULT BROWSER (`navigateExternal`, the opener plugin); the owner paid THERE, and the browser never brought him back to Canari. He switched back by hand to a form page exactly as he had left it: nothing said the payment was in progress or done. The payment was recorded by the confirm callback 43 s later - only the payer's view was wrong.

**What is measured, what is inferred.** Measured: Lydia redirects to an **https** `browser_success_url` after a payment (sandbox, from the dev web page, 2026-10-21, [lydia-api](../../lydia-api.md#4-where-the-payer-goes-back)). Never measured: a redirect to the **custom scheme** `fr.emse.canari://payment/success` the native builds sent - the hand-typed deep link of [device-verification](../../device-verification.md) proves the router, not Lydia. Inferred, not separated: either Lydia does not follow a non-https return, or the browser refuses to leave for an external scheme on a redirect with no fresh gesture.

**Which half depends on that cause.** The read on return does NOT: it needs no return URL at all. The https return DOES: if the browser is what refuses (no gesture), the same rule can keep a verified App Link in the browser too, and the payer lands on the web return page instead of the app - the browser half below is what makes that landing say the right thing. If Lydia is what refuses, https fixes it outright. A phone reading of an Android payment separates the two.

**The fix, in three parts.**

- **The form page reads the answer when the payer comes back** (`checkoutReturn.ts`). After `navigateExternal`, the submit keeps the answer's id and Lydia's page (`pendingCheckout`, with its own `PaymentReader`), and the page switches to `paymentPending`: "Paiement en cours sur Lydia" with a "Rouvrir la page de paiement" button. While it is pending, `watchReturnsToApp` listens to the app's ONE screen-transition source (`onAppScreenChange`, `appForeground.ts`: `canari:foreground` on the phones, `visibilitychange` elsewhere) and each return to the screen reads the answer ONCE through `confirm-payment` - the read `/forms/success` polls, which asks Lydia itself, so a lost callback is still caught. No timer.
  - **One read at a time, and only about the checkout shown.** The load-time read, the return read and the desktop tap all go through the checkout's reader, which answers `null` without asking while a read is in flight. The reader's IDENTITY is the checkout's generation: a read that lands after its checkout ended (released, then paid again under the SAME answer id; or the page moved from form A to form B, which reuses the component and resets everything per form, the reminder bell included) is dropped (`page.paymentReturn.svelte.test.ts`, with a control that fails without the check).
  - **The outcome** goes through `returnOutcomeOf` (`paymentReturnPoll.ts`), the mapping the return pages' poll uses: paid shows `form_success_confirmed_*` in the success banner, over capacity the `form_success_over_capacity_*` sentence, declined / ended the existing retry path, a final unpaid state (cancelled elsewhere) leaves the in-progress block and re-reads whether the person answered, and anything that can still change keeps "pending". A 429 is "pending" (`isConfirmThrottled`, shared with `/forms/success` and the guest receipt page); a failed read decides nothing and the next return asks again.
  - **Desktop.** A window switch fires no return edge there, so the desktop note promises nothing (`form_view_payment_in_progress_note_desktop`) and offers "Vérifier le paiement", the same single read on a tap.
- **Android returns on an https App Link** (`formCheckoutCallbacks`): `https://<public origin>/forms/success?...` instead of the custom scheme. `/forms/success` is under the `/forms/` prefix both platforms claim (`MOBILE_UNIVERSAL_LINK_PATHS`), and the server's allowlist (`isAllowedCheckoutCallbackUrl`) already accepted it - no server change. **iOS keeps the scheme** until a reading says otherwise (Safari prompts for a custom scheme rather than dropping it). The router keeps the `payment` host for builds already installed.
- **A browser landing never accuses.** When the https return stays in the phone's browser - a redirect the browser does not hand to the app, and ALWAYS on a pre-release build, since `dev.canari-emse.fr` is not an App Link host - `/forms/success` is read with whatever session that browser has. With none, the boot sends it to `/login` with the return behind it, and the login page now says "Paiement transmis à Lydia - retournez dans l'application Canari pour voir sa confirmation" with an "Ouvrir Canari" link (`paymentReturnSubmissionId`, `formPaymentReturnDeepLink`: the app's own `payment/success` link, which a TAP may open where a redirect could not). With a session that may not read the answer (401 / 403, `isConfirmUnreadableHere`), `/forms/success` says the same instead of "Paiement introuvable".

**The shop follows the same mechanism (2026-11-13).** `ProductPurchaseButton.svelte`, on a native phone, keeps the attempt after `navigateExternal` (`checkoutId` from `createProductCheckout`), says "Paiement en cours sur Lydia" with "Rouvrir la page de paiement", and reads it ONCE per return of the app to the screen through `createShopCheckoutReader` (`lib/shop/checkoutReturn.ts`, over the same `createOnceReader` / `readUnlessThrottled` the form page's reader is built on): the read is `confirmProductCheckout`, the call `/shop` already polls, worded by `checkoutReturnText`, which the shop page's banner now uses too. 429 stays "waiting", 404 says "introuvable", another failure keeps the note. The reader is the attempt's identity (a read landing after a newer purchase is dropped). Android now returns on the https `/shop` link (`shopCheckoutCallbacks`; `/shop` is an App Link path), iOS keeps the scheme. The watch starts BEFORE `navigateExternal` (here and on the form page): the browser may open and the call still reject, or resolve after the app already returned. A paid read says so in the button's own line and disables the button for a product that cannot be repeated; it does not reload the product listing. A buyer left in the phone's browser with no session sees, on `/shop` or behind `/login`, the same "Paiement transmis à Lydia" + "Ouvrir Canari" notice as a form payer (`PaymentHandedNotice`, `paymentReturnAppLink`).

**Not covered.** The public form (`/f/:id`) hands the guest to Lydia the same way but has NO read to use: its only key is the receipt, minted by the server and handed once in the Lydia return URL (`/f/:id/receipt?receipt=...`); the submit reply carries only `checkoutUrl`. Reading on return would need the receipt in that reply, a change to the security surface above that is a server decision, not taken here. `dev.canari-emse.fr` is not an App Link host, so a pre-release's https return always stays in the browser - adding it is a separate change. A WebView killed while the payer is in the browser reloads the form, whose load-time read covers it but without the reopen button (the shop button, being component state, loses its note the same way). Also not covered: no load-time read for a shop purchase (a page opened fresh after the browser was left reads nothing until the next return), the button's read does not share its in-flight guard with `/shop`'s own poll (two reads of one attempt may overlap; both are replays), and a remount on the same route loses the note. The https return's effect on Android is INFERRED from the sandbox measurement for forms, not measured for `/shop`; the landing notice is written for the case where it does not reach the app. Lydia's page inside the app is [a separate question](../../backlog.d/lydia-payer-page-inside-the-app.md).

### D1-D3 (user, 2026-10-15) and where each stands

| # | Decision | What it changes | State |
|---|---|---|---|
| D1 | The Lydia request dies with the hold | `submit` sends `expireAfterSeconds: PAYMENT_REQUEST_LIFETIME_SECONDS` = hold - `PAYMENT_REQUEST_EXPIRY_MARGIN_SECONDS` = 1800 - 120 = **1680 s** to `create-checkout-session`, and `lydia-payment-provider.ts` puts it in `request/do` as `expire_time` (whole seconds; a value that is not a positive integer is refused there, since Lydia reads 0 as "never"). The margin: Lydia's expiry sweep fired 61-79 s after the deadline on the sandbox, plus the callback's latency, so the request is dead before the seat is released | **DONE** (2026-10-15). A payment landing after the hold anyway is decided from the row like any late payment |
| D2 | Single-answer form: REUSE the pending row and SETTLE the previous Lydia request first (one row, one payable request) | `settleOpenRequest`, BEFORE the transaction and while the row still names its request: core-service `payments/cancel-request` (numeric `request_id` + vendor token). `cancelled` -> free. Error 2 (`already-settled`) was measured only on cancelled and expired requests and very probably answers a PAID one too, so it is followed by `payments/request-state` (uuid + vendor token, measured): `cancelled-or-expired` (6) or `declined` (5) -> free; **`paid` (1) -> the row is marked paid (`markPaid`) and the retry STOPS with `alreadyPaid`** (the payer paid in the app without coming back; a second request was a second charge). Anything else - a failed call, `open`, `unknown`, a row naming NO request (its request is being issued right now), a row written before 084 that names only its uuid and is still open - refuses with **409 `PREVIOUS_PAYMENT_OPEN`** (Paraglide `form_previous_payment_open` on the client) rather than leave two payable requests. **How long a refusal lasts:** at most until the row's hold ends, 30 minutes after `paymentRequestedAt`; past it the row is no longer live, is not reused, and the retry writes a new answer. For a row written BEFORE migration 084, `paymentRequestedAt` was backfilled from `createdAt`, so the bound is 30 minutes after the answer was CREATED - not 30 minutes after the deploy (as #1906's description said), and already over for any answer older than that when 084 ran. The client sentence names that bound ("au plus tard 30 minutes après son lancement"), not "in a moment". Only after a free answer does the transaction clear the ids, re-reading the row under its lock: it must still name the settled request, and a row its own request's cancel callback cancelled meanwhile is taken back (capacity re-checked). A request that is never issued (refused, failed, payments off) releases its row at once (`releaseUnissuedRow`). The submitter's own cancel (`cancelSubmission`) settles by the same rules | **DONE** (2026-10-15). A row past the hold is not reused (left for the job, a new row written); its request died with D1. Lydia's answer to `request/cancel` on a PAID request is not measured - the state read is what makes that unknown harmless |
| D3 | Notify the organiser actively on `paid_over_capacity`, plus the durable "cotisation granted" flag | the flag is built (`cotisationGrantedAt`); the notification is its own type under the EXISTING `forms` category | **BUILT, SWITCHED OFF** (2026-10-22): [the organiser alert](#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off) waits for `minClientVersion` to cover #1911. The return page's over-capacity sentence promises no notification, and keeps not promising one until the switch is on |

### The organiser is told when a payment lands over capacity (D3, built 2026-10-22, SWITCHED OFF)

A row that `markPaid` settles `paid_over_capacity` owes a refund nobody was told about: the WARN line and the pill at the top of the responses were the only trace. The alert tells the form's managers, once.

- **At most once, from the row.** `fulfilPayment` runs on every settle AND every replay; for a `paid_over_capacity` row it claims `organiserNotifiedAt` (migration 102, schema only) through the same `claimFulfilment` / `releaseFulfilment` pair as the two flags of 084 - a conditional `UPDATE ... WHERE "organiserNotifiedAt" IS NULL` exactly one caller wins - then writes the notice, and RELEASES the flag if writing it threw, so the next replay of the same payment retries it. A replayed callback, the payer's return racing the callback, or two settles at once write it once. No clock anywhere. The money path itself is unchanged: the status decision and the two older effects are as they were, the alert is a third effect after them.
- **P3, residual and accepted: a released flag is retried ONLY when the SAME payment confirmation is replayed.** Nothing sweeps `paid_over_capacity` rows with a NULL `organiserNotifiedAt`, so when the write fails and no replay of that confirmation ever comes, the alert is lost and the one trace is the ERROR line `alertOrganisersOnce` writes ("not written - released for the next replay"). The WARN of `markPaid` and the pill on the responses are still there.
- **Who: the owner, plus the association's members whose OWN rights carry `MANAGE_FORMS`** (`AssociationsService.listFlagHolders`). **Decided by the user (2026-10-22, #2228): the BDE super-admins are NOT included, and neither is a global administrator as such** - minimisation: a notification must lead to a page its recipient can open, and the tap opens `/forms`, which lists the reader's own forms and those of associations where they hold `MANAGE_FORMS` themselves (`FormsService.list`). If a BDE supervision is wanted later, it is a separate summary, not this notice. Not the payer.
- **What: the form's title, nothing else** - no payer, no amount (a lock screen is read by whoever holds the phone). One bell row per recipient, type `form_paid_over_capacity`, `postId` = the form, actor `system` / `Canari`; one push per recipient, `contentKey` `form_paid_over_capacity` with the title as its only argument, filed under the EXISTING `forms` category (`push-category.ts`: a new category id is a switch older clients cannot draw), no icon. `FormOrganiserAlertService` (`apps/social-service/src/forms/organiser-alert.service.ts`) owns the who and the what; the claim is `FormsService.alertOrganisersOnce`.
- **Where a tap lands: that form's responses.** They are an accordion on `/forms`, not a page, so the server writes the explicit deep link `fr.emse.canari://form-responses/<formId>` (`FORM_RESPONSES_TARGET` in `push-target.ts`, checked BEFORE the plain `form/<id>` that opens the page answering the form), `appRouteForDeepLink` and `notificationHref` both answer `/forms?responses=<formId>` (`frontend/src/lib/forms/responsesLink.ts`), and the list opens that accordion once it has loaded and scrolls to it. A form the list does not hold is said by `Log.i('forms.responsesLink', ...)` (so it reaches the in-app log a device reading sees) and nothing opens.
- **A push only fails a push.** The bell rows are what the claim covers; the pushes are LAUNCHED WITHOUT BEING AWAITED once the rows are written (bounded, best-effort), so a failed one is logged per recipient (`[FORM-ALERT] push failed`), the bell row stays, and the claim is not released - re-sending the whole notice to retry one push would tell the others twice.
- **THE SWITCH: `FORM_ORGANISER_ALERT_ENABLED = false`.** A client older than #1911 draws an unknown notification type as a COMMENT linking to `/posts/<formId>`, so a new type ships only once the floor covers that fix ([legacy-compatibility](../../legacy-compatibility.md#no-date-yet---a-notification-type-the-client-does-not-know-from-any-new-server-type)). #1911's first stable is `v1.2.9`; the floor reads `1.2.7` since 2026-10-17. **The switch stays ONE one-line constant (user, 2026-10-22).** **The exact precondition to set it to `true`:** `minClientVersion` at or above the version that CARRIES #2228 (its first stable, not merely `1.2.9`), on BOTH estates (production and dev each hold their own row in `/admin/platform`), once BOTH Play AND the App Store serve that version. **The flip is a follow-up pull request** that changes the constant AND the spec pinning it (`organiser-alert.service.spec.ts`, "ships switched off"), and nothing else; someone else runs it. While it is off, a row settled over capacity is NOT claimed (`organiserNotifiedAt` stays NULL) and a debug line says so; the WARN of `markPaid` is unchanged. **Why `1.2.9` is not enough:** a build between `1.2.9` and the release carrying #2228 would show the bell row as the neutral "cannot show" row of #1911, and on Android drop the tap's link (the host `form-responses` is declared in `tauri.conf.json` and the manifest only from #2228 on), so the app would open where it was. The precondition above is what removes both.
- **Tests and controls.** `forms.service.seat-hold.spec.ts` (the claim around a stubbed service: off, once, replays sequential and concurrent, a failed write released then retried, a seated payment never told), `organiser-alert.service.spec.ts` (recipients, the row, the push payload, a failed write throws, a failed push logged), `organiser-alert.integration.spec.ts` against real Postgres (migration 102 applied to a `synchronize`d table and re-run, the real `markPaid`, `listFlagHolders` and `post_notifications`, every case above). Each guard was removed and the tests failed, then restored byte for byte: the switch check (2 fail), the claim (8), the release (2), the over-capacity condition (2), the `MANAGE_FORMS` holders (6), the responses deep link (1), the switch flipped on (1). On the client: the bell href, the deep-link host, the row sentence and the list's link handling each fail their test when removed.

Tests: `forms.service.seat-hold.spec.ts` runs the service on an in-memory store that evaluates its own `where` clauses and refuses any transaction that is not READ COMMITTED (the boundary one second either side of the hold, two simultaneous submits on the last seat, the reuse restarting the hold on a full form, the job twice, a late payment with and without room, two simultaneous late payments on the last seat with a real per-form mutex, replays, a failed grant retried, one payment confirmed under both ids in both orders, a cancel against a paid row, a cancel naming another request (not even read at Lydia), a verified cancel whose request Lydia reads open, unmeasured, paid or not at all (the seat kept, or the payment recorded) and one whose request a retry replaced during the read, the request lifetime (1680 s), the old request settled before the new one with the row still naming it, an old request found PAID stopping the retry, a failed cancel / open state / failed state read / request being issued each refused with `PREVIOUS_PAYMENT_OPEN`, the old request's cancel callback landing DURING the retry and taken back, the submitter's cancel settling the request, a confirmation naming another request accused at ERROR, a late payment on a one-answer form whose payer already has a seat or a payment, the payer's return (`confirmPayment`) recording a payment no callback confirmed, then a late callback as a silent replay, and leaving an open/unknown/unreadable request pending, and the bodies core-service posts entering through `InternalFormsController`: webhook confirm and the payer return's uuid in both orders and at once, a cancel or expire callback after the payment, one between the two confirmations, a payment after its own expiry - one transition, one grant, one purchase each). Controls (each makes it fail): the lock removed from `markPaid`; REPEATABLE READ put back in `submit`; the cancel comparison removed; error 2 read as cancelled without the state read; a failed settle carried past; the one-answer check removed; the foreign-id accusation removed; the take-back of a self-caused cancel removed. The core half is in `lydia-payment-provider.spec.ts` (`expire_time`, `request_id`, `request/cancel` and its error 2, `request/state` and its codes) and `payment.controller.spec.ts` (`request-state` takes the uuid as Lydia issues it, 32 hex digits; it fails on the old dashed pattern). **Real Postgres is NOT in CI**: the Postgres 18 runs quoted on this page (concurrency, migration 084 twice, the hold restart surviving the id write, the real core controllers wired to the real internal route) were throwaway scripts on the pull request, not committed tests - the committed proof is the in-memory store above. `paymentStatus.test.ts` and `paymentReturn.test.ts` (with `paymentCancelView`) on the client.

## What a client reads of a submission is an allowlist (2026-10-15)


**The rotation of the payment-provider and document-vault secrets that were readable before this allowlist is DONE, per the user, 2026-10-22** (relayed by the lead session; the exposure windows stay in the private notes).
`GET /api/forms/submissions/:id` (the submitter or a manager, read by the payment return pages)
answered a payment-provider account credential that no client field read. The two submitter reads and the two
manager lists (`:id/submissions`, `:id/submissions/pending-cash`) also answered the whole row:
the provider ids (`stripeSessionId`, `paymentRequestId`, `paymentSettledBy`), the hold clock and
the fulfilment flags.

`apps/social-service/src/forms/submission.projection.ts` now decides, as an ALLOWLIST, so a column
added later is private until someone adds it there:

- the submitter's view: `id`, `formId`, `answers`, `lines` (a priced grid's charged lines,
  [below](#the-priced-grid-product_grid-wp-g1-2026-11-06)), `totalPaid`, `paymentStatus`,
  `paymentMethod`, `cashExpiresAt`, `createdAt`. `GET submissions/:id` answers `id`, `formId`, `totalPaid`,
  `currency` and `paymentStatus` only.
- the manager's view adds `userId` and `email`. Both lists use `userId` to name the submitter
  (`submitterName`, the pending-cash list), and a manager already reads both on member pages.

`submission.projection.spec.ts` fills every private column (and the vendor token) with a
recognisable value and fails if any client read carries one, by value or by key name. Control: it
fails 4/4 against the previous service.

**The association reads had the same leak, closed the same way (2026-10-15).** `GET
/api/associations` and its siblings answered the same payment credential and other private columns, through a denylist rather than an allowlist.
`apps/social-service/src/associations/association.projection.ts` (`toAssociationView`) is now an
allowlist on every route that answers a row: `GET /`, `slug/:slug`, `:id`, `me/list`, `POST /`,
`PATCH :id` and both logo routes. The token and the dashboard URL have their own read,
`GET /api/associations/:id/payout-account`, behind `canManagePayoutAccount` (MANAGE_PAYOUT_ACCOUNT,
the permission the onboarding and the disconnect already ask; a BDE super-admin does not inherit
it), and the Lydia panel (`LydiaBusinessOnboardingForm.svelte`) is its only reader.
`associations.controller.spec.ts` fills the token, the dashboard URL, the vault key and the notes
with recognisable values and fails if any of the eight routes answers one, by value or by key name;
a member without the flag gets a 403 from the payout read. The token was readable by every member
until this shipped, so whether it can be rotated is a question for Lydia
([backlog](../../backlog.md)).

## The priced grid (`product_grid`, WP-G1, 2026-11-06)

**Server side built (WP-G1), the fill page (WP-G2, [below](#the-fill-page-wp-g2)) and the editor
(WP-G3, [below](#the-editor-wp-g3)); the client half of the export (WP-G4) builds on it.** Decided by the owner on 2026-11-06; design, use cases and the work
packages: the forms capability audit of 2026-11-06 (`docs/wiki/forms-capability-audit-2026-11-06.md`),
section 4.

**The builders offer the type since WP-G3.** `QUESTION_TYPES` (frontend) lists it, because a form
may hold it and the server's `SUPPORTED_QUESTION_TYPES` must equal that list; the two pickers
(`FormBuilder.svelte`, `FormQuestionsSection.svelte`) read `AUTHORABLE_QUESTION_TYPES`, an explicit
list of the types whose editor exists (`questionTypes.ts`, asserted by `questionTypes.test.ts`),
which gained `product_grid` with its editor. A builder whose answers never pay - a booking space
(`SpaceEditor.svelte`) - passes `offerPricedGrid={false}`: every grid there would be refused
`PRODUCT_GRID_REQUIRES_PAYMENT`. The fill page reads its own list, `FILLABLE_QUESTION_TYPE_VALUES` (`fillAnswers.ts`
`isKnownQuestionType`), which holds `product_grid` since WP-G2: an older build draws a priced grid
"update the app" and blocks the send.

A new question type - NOT a mode of the survey grids (`matrix_single`, `matrix_multiple`): an
order, rows x columns ("Vert" x "M"), each cell a quantity, each unit at the price of the payer's
category. No stock (a pre-order); no total cap per order (the cap per cell is enough); a second
order is a second answer (`allowMultipleSubmissions`), never an edit.

**Each grid has its own "Obligatoire" switch, OFF by default (owner, 2026-11-13, for `1.6.12`).**
A merch form holds one grid per article (sweat capuche, sweat col rond, sweat zippé, veste softshell)
and a buyer orders whichever they want, so a grid is optional unless its manager switches it on;
switched on, a VISIBLE grid demands at least ONE unit of its own (no configurable number). A grid
hidden by an audience or an answer condition is never demanded. **No rule spans the grids**: a form
whose grids are all optional accepts an answer with no article at all, which the owner intends
(*"Avoir des règles globales interdit des formulaires moins conventionnels, il faut éviter les
règles globales"*). History in one line: a per-grid rule of WP-G1 (every article demanded) became on
2026-11-06 a rule over the whole order (`PRODUCT_GRID_EMPTY`, one unit across the visible grids,
`required` stored `true` and meaningless), which this switch replaced.

**One predicate, both sides.** A grid is answered when it holds >= 1 unit: `productGridOrdered` in
the shared contract, read by the fill page (`isItemAnswered`, `firstMissingAnswer`) and by the submit
(`FormsService.submit`). A required grid left empty is refused like every other required question:
`FORM_ANSWER_MISSING` with the grid's `itemId` on the server, `MissingAnswer { itemId, kind: 'grid' }`
on the page, said on the grid's own card ("Commandez au moins un article de 'Sweat'"), which is
scrolled into view. An order in another grid does not rescue it.

**The stored flags were turned off by migration 164** (held, a backfill): every grid saved before the
switch held `required: true`, and honouring that as it stood would have demanded one of EVERY article -
the defect of 2026-11-06. 164 sets `required: false` on every stored grid, keeps every other question
and key, and moves the base of an open revision built on the form (so its publication is not refused
`FORM_CHANGED_SINCE_REVISION`); `product-grid-required.integration.spec.ts` proves it, the idempotence
and the ROLLBACK statement of its header.

**An editor older than the switch** (native `1.6.6`..`1.6.11`) sends `required: true` on every grid,
meaning nothing. This editor marks its payload `gridRequiredSwitch: true` (`GRID_REQUIRED_SWITCH`,
never stored); a save WITHOUT it keeps each grid's STORED flag and stores a new grid optional
(`productGridRequiredOnSave`, the contract) - an old editor neither makes a grid required by surprise
nor drops a choice a newer one made. A revision such an editor saved opens here with the same rule
(`revisionItems`). [LEGACY] in [legacy-compatibility](../../legacy-compatibility.md). An older FILL
page still holds a send on "Commandez au moins un article" across the grids (stricter than the server)
and does not mark a required grid's card - the server's `FORM_ANSWER_MISSING` then words it.

**A newer app reaching a SERVER older than the switch** (a store build lives on phones days before
production deploys) is the reverse hazard: that server refuses a grid sent optional
(`PRODUCT_GRID_NOT_REQUIRED`), drops `gridRequiredSwitch`, and refuses an empty order
(`PRODUCT_GRID_EMPTY`). So core-service's `GET /api/version` says `gridRequiredSwitch: true`, and the
client reads it through ONE gate, `gridRequiredSwitchOn()` (`lib/forms/gridRequiredGate.ts`). Off -
an older server, or no answer yet - the editor draws no switch and no asterisk on a grid and sends
every grid `required: true` without the marker; the fill pages ignore a grid's flag and hold an
empty ORDER across the visible grids beside the send button (`firstMissingAnswer(..., gridSwitch)`,
kind `order`). The two old codes keep their words. [LEGACY] in
[legacy-compatibility](../../legacy-compatibility.md), "a form editor or fill page newer than its
server's priced grids".

**An empty send on a once-only form is that person's answer.** A send with every grid optional and
empty is stored `free` at 0, and `answerHoldingWhere` counts `free`: on a form with
`allowMultipleSubmissions` off, that person's later real order is refused `409 ALREADY_ANSWERED`,
exactly as a once-only form sent without an article always was. Adding a grid turns "plusieurs
reponses" on in the editor, so a manager reaches this only by turning it back off.
`product-grid.integration.spec.ts` pins it.

### One contract, copied byte for byte

`apps/social-service/src/forms/product-grid-contract.ts` = `frontend/src/lib/forms/productGridContract.ts`
(declared duplicate, `exact`; its spec sits beside the server copy). It holds the stored shape, every
refusal code, the structural rule a definition obeys (`productGridItemRefusal`), the rule an answer
obeys (`parseProductGridAnswer`) and how a quantity becomes a priced line (`productGridLines`). The
editor refuses what the save refuses and the fill page totals what the submit charges, by the same
code - and the server recomputes every amount anyway.

The definition is nested under `item.productGrid` (not flat on the item as the audit sketched): the
DTO's `rows?: string[]` already belongs to the survey grids and cannot also hold objects.

```ts
item = { id, type: 'product_grid', label, required, showIf?, productGrid: {   // required: the switch
  rows: [{ id, label }], columns: [{ id, label }],     // ids /^[A-Za-z0-9][A-Za-z0-9_-]{0,35}$/
  maxPerCell: 1..99,                                    // 1 = a checkbox, more = a stepper
  closedCells: ['rowId:colId'],                         // "no Creme in XS": cannot be ordered
  pricing: { mode: 'single' | 'per_row' | 'per_column',
             tiers: null | Dimension,                   // ONE cotisation, promo or formation criterion
             prices: { [tierId]: { [axisKey]: cents } } } } }
answer = { 'rowId:colId': quantity }                    // zero cells omitted when stored
```

`tierId` is a bucket id and `_others` ("everyone else", where every guest lands), or `_all` when
`tiers` is null; `axisKey` is `*`, a row id or a column id by the mode. No row + column surcharge.

### The save (`FormsService.create`/`update` -> `normaliseProductGridItems`, `forms/product-grid.ts`)

Each refusal is a 400 `{ code, message, itemId }`: `PRODUCT_GRID_DEFINITION_MISSING`,
`_REQUIRES_PAYMENT` (a grid charges, so `requiresPayment` - which also makes an
anonymous grid form impossible), `_AXIS_INVALID` (1..40 rows, 1..15 columns), `_ID_INVALID`,
`_DUPLICATE_ID`, `_LABEL_INVALID` (empty or over 100), `_DUPLICATE_LABEL` (per axis, trimmed and
case-folded - the survey grids' row rule should match it), `_MAX_PER_CELL_INVALID`,
`_CLOSED_CELL_INVALID`, `_ALL_CELLS_CLOSED`, `_PRICE_MODE_INVALID`, `_TIER_INVALID` (not a profile
criterion, or refused by the price grid's own `parseDimension` - a tier the association does not
sell, a promo that is no year - or two categories that can hold one person, or a cotisation on a
personal form), `_GUEST_PRICE_MISSING` (a public form without the price a guest pays, named before
the rest of completeness), `_PRICES_INCOMPLETE` (exactly one price per category x axis key),
`_PRICE_INVALID` (integer cents, 0..1 000 000). The grid is STORED normalised: known fields only,
labels trimmed, the tier criterion as the parser returned it, `required` as
`productGridRequiredOnSave` decides (above). An edit that only opens the link or
switches payment off is judged against the stored grids. A `productGrid` sent on another type is
dropped. The prices enter `priceFingerprint`, so a list moving a grid price meets
`assertKindMayPrice` like any other price.

### What a page is told

`GET /forms/:id/check` and the public read carry `productGridPrices: { [itemId]: { tierId,
tierLabel, prices } }`: each grid's prices for THIS viewer, the category resolved on the server
(`viewerPricesFor`, the price grid's `bucketFor`; a guest's facts know nobody, so `_others`). The
public read serves the grid without its price lists (`respondentItems`). `GET /forms/:id` still
serves the whole form - the editor reads it, as it reads the whole price grid.

### The submit (`FormsService.submit`)

For each VISIBLE grid, before the `required` check every other type takes: `priceProductGridAnswer`
judges the answer - 400 `PRODUCT_GRID_ANSWER_MISSING` (a non-object - a string, a list: an app that
cannot draw the type, which a newer client words "mettez a jour l'application"), `_UNKNOWN_CELL`,
`_QUANTITY_INVALID` (not an integer in 0..maxPerCell), `_CELL_CLOSED` - then prices it at the
viewer's category. An ABSENT answer, `{}` or all zeros is an untouched grid: 0 units, no line, and
nothing stored under its id (a `{}` sent is dropped from the stored answers). A grid switched
"Obligatoire" holding 0 units refuses the submit `FORM_ANSWER_MISSING` with ITS `itemId`
(`productGridOrdered`), before any row is written - member and guest alike. The stored answer is
the judged one; the lines' sum joins `totalCents` with the base price
(or the price grid's cell) and the choice supplements. A grid order whose total exceeds
`PROVIDER_MAX_AMOUNT_CENTS` is refused `AMOUNT_OUT_OF_RANGE` BEFORE any row is written, cash
included. Nothing else changes: the total is the ONE `unit_amount` sent to core-service, the
payable-range check, the 30-minute seat hold, the reuse of a pending row (its answer, lines and
total rewritten together), the D2 settle, cash, `markPaid` and refunds (a total refund frees the
seat; the lines stay). A hidden grid is neither required, charged nor stored.

**`submissions.lines`** (migration 137, `jsonb NULL`, additive, not held): per ordered cell
`{ itemId, itemLabel, rowId, rowLabel, colId, colLabel, quantity, unitCents, lineCents, tierId,
tierLabel }`, null on an answer without a grid. In the submitter's and the manager's views. It
holds no account id, so an account erasure leaves it as it is (`NO_ACCOUNT` in
`internal/account-erasure.ts`, which the coverage spec requires of every jsonb column).

**The answers validator is ONE function**, `isAcceptedAnswerValue` in `forms/answer-bounds.ts`
(WP-G0's, which `IsValidAnswers` calls): a flat object whose values are ALL numbers is a priced
grid's answer - at most `PRODUCT_GRID_MAX_CELLS` (40 x 15 = 600) keys of at most 73 characters,
finite numbers - and any other flat object is a survey grid's (50 rows of strings or string
lists); a map mixing the two is refused. Both bounds are in `libs/contracts/form-answers.json`
(`maxProductGridCells`, `maxProductGridCellKey`). `withNormalisedGridAnswers` passes a
`product_grid` answer through untouched to `priceProductGridAnswer`, the only judge of what it
means; a number map on any other question is still `FORM_GRID_ANSWER_INVALID`.

### The fill page (WP-G2)

Both fill pages hand a `product_grid` question to `ProductGridQuestion.svelte` instead of
`FormQuestion.svelte` (its own card: the product photo across the top, the title and the
viewer's price - "des X" when rows or sizes differ - and the description as the spec line). The
design is the owner's mockup of 2026-11-06 (`Fill-Desktop`, `Fill-Mobile`, `Fill-Guest-Mobile`),
drawn with the app's tokens.

- **Two drawings of one answer, picked by CSS alone (`sm`, 640px).** From 640px a table with
  alternating rows: each open cell a "+" that becomes a - n + stepper (+ disabled at `maxPerCell`),
  a checkbox when `maxPerCell` is 1. Below it a card per row, its sizes as pills that wrap - a tapped
  pill becomes "M x1" with - and + (a toggled pill at a cap of 1) - so nothing scrolls sideways. A
  closed cell is struck through and has no control. The pill stepper's - and + are `h-11` themselves:
  `h-full` inside the bordered `h-11` pill was 42px, under the touch floor (fixed in WP-G3). A grid of ONE row has no row label anywhere.
  `per_row` writes the price on each row (both drawings), `per_column` under each size (and in each
  pill).
- **The answer** is `{ "rowId:colId": quantity }` holding only the cells ordered
  (`productGridFill.ts` `withCellQuantity`: clamped to 0..`maxPerCell`, a cell at 0 dropped, a new
  object per write so `bind:value` sees it), sent through the unchanged submit path.
  `initialSelections` starts it `{}`; `isItemAnswered` / `firstMissingAnswer` want one unit of a
  REQUIRED grid (`kind: 'grid'`). The card draws the asterisk of a required grid. The fill page draws it because `FILLABLE_QUESTION_TYPE_VALUES` holds
  `product_grid` (`questionTypes.test.ts` asserts the fill page draws every canonical type).
- **The total.** `fillPriceState` takes `productGridPrices` and returns `gridLines` (every visible
  grid's lines, `productGridOrderLines` -> the contract's `parseProductGridAnswer` +
  `productGridLines`) and `gridCents`; its `total` is base + supplements + lines, the sum
  `FormsService.submit` charges. It is a PREVIEW. A grid the server sent no prices for, or an answer
  the contract refuses, adds no line and logs at error level - never a total the submit would
  contradict.
- **The bar.** `ProductGridOrderBar.svelte`: "Total : 84 EUR", the article count, and a recap that
  unfolds line by line ("Sweat capuche Noir M x1 28 EUR"; a one-row grid's line has no row), beside
  the page's own pay button (one `{#snippet}` per page, shared with the plain bar). A member form
  holding a visible grid keeps its bar `sticky` from the start (the `reachedEnd` latch still governs
  every other form); the guest page sticks its footer the same way.
- **Who pays what.** `FormViewerTier.svelte`, at the foot of `FormHeader`: "<display name> - Tarif
  applique : <category>" for a member, "Tarif applique : Tous les autres" and a sign-in link
  (`/login?returnTo=/forms/:id`) for a guest. The category is `productGridPrices[id].tierLabel`, or
  `form_criterion_others` for `_others`; a grid with one list (`_all`) names none, and the line is
  absent when no visible grid prices by category.
- **Refusals.** A REQUIRED grid with no unit holds the send on its own card ("Commandez au moins un
  article de ...", `MissingAnswer` `{ itemId, kind: 'grid' }`), scrolled into view like any required
  question; an optional grid is never a fault, and nothing is said for the form as a whole. The
  server's four answer codes are worded by `productGridRefusalMessage` (`PRODUCT_GRID_ANSWER_MISSING`
  -> reload or update; the three cell codes -> "an item is no longer offered"), reached through the
  ONE entry point both pages call, `formSubmitRefusalMessage` (`answerBounds.ts`), whose
  `formCodeMessage` falls through to it for any code that is not a form's own; a required grid the
  server finds empty is its `FORM_ANSWER_MISSING`. An untouched grid is left out of the answer sent
  (`visibleAnswers`).

Tests: `productGridFill.test.ts` (clamping, lines and total across two grids, a hidden grid, missing
prices, the category words, every code), `ProductGridQuestion.svelte.test.ts` (stepper bounds,
closed cells, the checkbox, the phone pill path, a one-row grid, both price modes, the error
state), `routes/forms/[id]/page.productGrid.svelte.test.ts` (the bar's total and recap across two
grids, the category line, a send held on the grid).

### Responses and export (server half of WP-G4)

`answerText` (both copies) reads a grid `Vert / M x2; Noir / L x1`, from the row's `lines` (what
was charged, so a renamed or deleted row keeps its old label) before the grid's labels. The XLSX
adds two sheets (`forms/product-grid-export.ts`): **Articles**, one line per ordered cell (date,
buyer - a member's name, or the guest word and its reference -, question, row, column, category,
quantity, unit price, line total, status); **Totaux**, per grid, quantities per row x column with
row totals, column totals and amounts, counted over `paid` + `free`, then the same block for
`pending_cash` (money not yet received). The words come from the client's
`ExportLabels.productGrid` (16 keys); a grid form exported without them is refused
`EXPORT_LABELS_PRODUCT_GRID_MISSING`.

Tests: `product-grid-contract.spec.ts` (every code, every mode), `forms.service.product-grid.spec.ts`
(the save, both reads, the charge per mode and category, a guest, forged answers and amounts, cash,
the total bound, the real `ValidationPipe`), `product-grid-export.spec.ts` (the three sheets read
back), `answer-text.spec.ts`, and against PostgreSQL `product-grid.integration.spec.ts` (migration
137 twice, lines through jsonb, the reused row rewritten, the seat held then freed) and
`refunds.integration.spec.ts` (a total refund of a grid order).

### The editor (WP-G3)

`ProductGridEditor.svelte`, drawn by `FormBuilder.svelte` inside the question card when the type is
`product_grid`; the model and every rule are in `forms/productGridEditor.ts`, so the component only
draws them. Built from the owner-approved mockup of 2026-11-06 with the app's tokens.

- **The table is the editor.** Columns are chips in the header row (renamed in place, removed by
  their x), rows a narrow first column of inline inputs, "+" adds a column and "Ajouter une ligne"
  a row (the new blank label takes the focus); the table itself is `GridAxesTable.svelte`, shared
  with the "Grille de choix" since 2026-11-07. **"Coller une liste"**, under the table, takes one value per line
  (commas, semicolons and tabs also split) and appends them as rows or as columns; a label already
  on the axis (trimmed, case folded - the save's own comparison) is refused and named, and what
  passes the axis maximum (40 rows, 15 columns) is counted, never dropped silently. A new grid's
  one blank row or column gives way to a pasted list. Two labels of one axis that collide are
  marked as they are typed (`collidingLabelKeys`).
- **Reordering**: each row and column has a grip, dragged onto another entry (its drag events stop
  at the grid, so the question card does not move) or moved with the arrow keys (up/down for a
  row, left/right for a column). **No HTML5 drag reaches a touch screen**, so on a coarse pointer
  or below `sm` each row has up/down buttons beside its label and each column left/right buttons
  under its chip (`ui-icon-button`, 44px, labelled with the entry: *"Monter la ligne Vert"*), the
  way the question list moves on a phone (#3083); the grips are hidden on a coarse pointer. Focus
  follows the entry to the same button, or to the other one at the end of the axis.
- **On a phone (below `sm`) the table fits the screen**: measured at 390px, a grid of six sizes
  draws in the 304px the question card leaves, with no sideways scroll. The table takes the full
  width; each size column is 32px (`max-sm:w-8 min-w-8`), its chip stacked (label, x, then the
  left/right arrows under it, as wide as the column with `tap-target` hit boxes); the row label
  column takes the rest (at least 104px), its label a `textarea` that wraps and
  grows (`fitLabel`: on input, and on a WIDTH change only, so the height it sets never feeds the
  observer back; a typed or pasted line break becomes a space), the row's x 32px beside it and its
  up/down arrows under it. A cell shows its state without its price (a closed one an x); the
  header "+" gives way to an "Ajouter une colonne" button beside "Ajouter une ligne", both now
  under the table rather than in its footer so a scrolled table never carries them away. **A grid
  too wide to fit** (more than six sizes, or a per-row / per-column price) scrolls inside its own
  box, never the page, with the row labels and the corner `sticky` on the card's surface. From
  `sm` up nothing changed.
- **Touch targets**: the chip's x keeps the chip's drawing and is widened to 44px by `tap-target`
  (the chip still sizes it, so `iconButtonScale.test.ts` keeps its exemption); the price-mode and
  criterion-kind buttons take `tap-target`; the price inputs, which no `::before` can widen, grow to
  44px (`pointer-coarse:min-h-11`).
- **Ids**: `crypto.randomUUID()`, which the contract's id pattern accepts. Renaming a label never
  changes an id - answers, prices and closed cells are keyed by it.
- **Closing a cell**: a click closes the combination (struck through, "Fermee") and a second
  reopens it. The last open cell cannot be closed (`PRODUCT_GRID_ALL_CELLS_CLOSED`), and neither
  can a row or column be REMOVED when every cell left would be closed (`removalClosesEveryCell`;
  `removeAxisEntry` answers `closes_every_cell` and touches nothing): the gesture is refused under
  the table (*"Impossible de supprimer..."*), before any orders confirm, and nothing reopens the
  manager's closed cells behind their back.
- **Prices**: *Un prix pour tout / Par ligne / Par colonne*; the inputs appear where the mode puts
  them (one field, a price column beside the rows, a price row under the headers). EUROS in the
  editor, typed with a comma or a dot; a blank stays `null` and is LEFT OUT of the payload, so the
  contract names the list incomplete instead of the save charging 0. `parseEuroInput` accepts digits
  and one separator only (`1e3`, `0x10`, a sign are unreadable, hence blank) and rounds to the cent
  ON THE DIGITS (`1,005` is 1,01; a float round would give 1,00), and the field is rewritten with what
  was stored, so the field, the cell and the cents sent never disagree. A price above 10 000 EUR is
  kept and refused by name (`PRODUCT_GRID_PRICE_INVALID`), never clamped. A key the new mode needs
  starts at its category's single price, else the last price of the mode, else any price the list
  holds, so switching modes or adding "XXL" changes nothing until the manager edits it. Keys of
  another mode stay in the editor and never reach the wire.
- **Categories**: a *Prix par categorie* switch. On, it takes the registration price grid's profile
  criterion when the form has one (`profileTierCriterion`: the first cotisation, promo or formation
  dimension holding a category - never an answer, which a grid cannot price on), else a new
  cotisation criterion (promo when the association sells no cotisation); *Selon* switches the kind,
  and the categories are edited with the price grid's own `CriterionEditor`. One TAB per category,
  "Autres" (`_others`) always last; each tab is a complete price list, a new category starting as a
  copy of "Autres". On a public form the hint says a guest pays "Autres", and the save names that
  price first (`PRODUCT_GRID_GUEST_PRICE_MISSING`). **Leaving a criterion asks first** when it
  would lose input (owner, 2026-11-07): another *Selon*, the registration grid's copy, or the switch
  turned off keep only "Autres"'s list, so `tierSwitchLosesInput` asks when a group names anyone or
  a group's prices differ from "Autres"; a criterion still as it started is left at once.
- **Cap per cell**: a stepper, 1..99, default 5; at 1 the hint says the buyer gets a checkbox.
- **Preview**: the fill page's own `ProductGridQuestion.svelte`, inert, toggled *Ordinateur /
  Telephone* through its `layout` prop (`desktop` / `phone` force one drawing at any width; the fill
  pages keep `responsive`, the 640px switch). It is handed what a buyer would be: `editorGridView`
  (the payload less its price lists) and `editorViewerPrices` (the tab on screen's list, in cents,
  a blank price absent) - so the preview cannot draw a grid the fill page would not.
- **The "Obligatoire" switch**, the card's asterisk button like every question's (owner,
  2026-11-13): a new grid (or a question turned into one) starts OFF; the folded row of a required
  grid wears the asterisk. `toFormItemsPayload` sends the flag as the card holds it, and every
  payload carries `gridRequiredSwitch: true` (see "Each grid has its own Obligatoire switch" above).
  `productGridItemProblem` never flags a grid for its flag. Adding a grid also calls the page's `onPricedGridAdded`, which switches
  `allowMultipleSubmissions` on (a second order is a second answer, decision Q3) - the manager may
  turn it off. **It goes back off only if the editor turned it on**: the page keeps
  `multipleTurnedOnByGrid` (`GridMultipleSubmissions`, `multipleSubmissionsAfterGridAdded` /
  `...AfterGridGone` in `productGridEditor.ts`), set only when a grid switched it from off;
  removing a grid or changing its type calls `onPricedGridGone`, which switches it off when that
  flag is set AND no grid remains. Any write through the switch's binding - the manager's toggle,
  or the public switch forcing it on - clears the flag, so the choice is theirs from then on.
- **The wire** (`itemsPayload.ts`): `toFormItemsPayload` sends `productGrid` as
  `productGridPayload` builds it - the contract's exact shape, cents, one price per category x
  axis key, closed cells of live entries only - and drops it from any other type; `fromFormItems`
  reads cents back as euros (`editorProductGrid`; a broken stored grid opens as a new one).
- **Validation**: `firstProductGridProblem` runs the contract's own `productGridItemRefusal` on that
  payload before the save, so the page refuses what the server refuses and in the same words. The
  page shows the question's title and the sentence in its banner, opens the card through `reveal`,
  and the card repeats the sentence under the table (`gridFault`). The server's coded 400 is worded
  by the same `productGridDefinitionMessage`, reached through `formCodeMessage`'s default branch.
  **A refusal only the server can make** (`PRODUCT_GRID_TIER_INVALID` for a cotisation tier the
  association does not sell, or any definition code the local check missed) is drawn the same way:
  its body carries `itemId` (`ProductGridRefusalBody`, `product-grid.ts`), the forms client keeps it
  on `SocialApiError.itemId`, and `refusedProductGridFault` (`questionFault.ts`) turns it into the
  page's `gridFault` and opens the card. A grid code naming no grid of the form is logged at error
  level and leaves the banner alone.
- **Duplicating** (`questionDuplicate.ts`): the copy's rows and columns get FRESH ids
  (`withFreshProductGridIds`), its closed cells and price keys following them; two questions
  sharing a row id would read as one article in the export's totals.
- **Removing an ordered row or column** (edit page): the server does NOT refuse it (an answer keeps
  its `lines`, so its export still names what was charged). The edit page reads the form's answers
  once when a grid has any (`getSubmissions` -> `orderedProductGridCells`), and removing a row or
  column an answer ordered asks first (*"Des reponses contiennent cet article..."*). A failed read
  is logged and leaves removals unwarned; it never blocks editing.

Tests: `productGridEditor.test.ts` (every edit, the payload judged by the contract, modes,
categories, a guest's price, the wire trip, fresh ids, every code worded, ordered cells, colliding
labels, a removal refused for closing every cell, "Plusieurs reponses" switched back),
`ProductGridEditor.svelte.test.ts` (add, rename, remove with and without orders, paste, arrows,
the touch arrow buttons and 44px targets, a removal refused under the table, closing a cell, the
three modes, the cap, category tabs, the preview),
`FormQuestionsSection.svelte.test.ts` (offered on a form and not on a booking space, added required
and opened, a refused save drawn under its grid, the page told when a grid goes), `itemsPayload.test.ts`, `questionDuplicate.test.ts`,
`questionTypes.test.ts`, `questionFault.test.ts` (a server refusal mapped to its grid),
`api.refusal.test.ts` (`itemId` carried), `routes/forms/create/page.pricedGridMultiple.svelte.test.ts`
("Plusieurs reponses" back off with its grid and never against the manager; a server-only refusal
drawn under a folded grid).

### Adding a question, the "Grille de choix" and the editor's menus (owner, 2026-11-07)

The owner's reading: *"A l'ouverture d'un menu, ou l'ajout d'une question, il faut absolument
mettre un wizard et rendre les choses simples et bien ordonnees"*, and the three grids had three
editing looks. Three decisions, layout and grouping only - no feature removed, no server change.

- **Adding a question is two steps** (`AddQuestionWizard.svelte`, a `Modal`: a bottom sheet on a
  phone, a dialog wider up). Step 1, *"Quel type de question ?"*, lists the authorable types by
  family - TEXTE (short, long), CHOIX (single, multiple, dropdown, scale), GRILLES (Grille de
  choix, Grille d'articles), AUTRE (file) - icon left, label left-aligned, one line of
  description each; the layout is `editorQuestionFamilies()` in `forms/questionTypes.ts`, and a
  family with no offered type is dropped (a booking space offers no priced grid). Step 2 asks only
  the type's essentials, through the SAME editors the card uses: the title, then the options
  (`ChoiceOptionsEditor`), the scale (`ScaleEditor`), the rows and columns with the switch
  (`MatrixGridEditor`), or the rows, columns and prices (`ProductGridEditor` with `essentials`,
  which hides the cap per cell and the preview); a text or file question gets "Obligatoire". The
  back arrow returns to step 1 with the chosen type focused; "Annuler" and Escape insert nothing
  and give the focus back to the opener; "Ajouter" inserts the filled card (`insertQuestion` in
  `forms/questionDraft.ts`) at the end, or right after the card whose "..." menu asked for it, and
  opens it. Image, description and display conditions stay in the card.
- **One "Grille de choix"** replaces "Grille unique" and "Grille multiple" in every list (the
  wizard, the card's type menu). The stored types do not change: the switch *"Plusieurs reponses
  par ligne"* writes `matrix_multiple` when on and `matrix_single` when off
  (`setMatrixMultiple` in `forms/matrixEditor.ts`), and an existing `matrix_multiple` opens with it
  on. Its rows and columns are edited in the priced grid's own table, `GridAxesTable.svelte`
  (extracted from `ProductGridEditor`, which now draws its prices through that table's snippets):
  chips, inline rows, drag and arrows, touch buttons, "Coller une liste" under the table. A cell
  shows what the respondent ticks there, a radio or a checkbox. On a phone a column is the priced
  grid's narrow 32px column, so a long column label truncates there exactly as it does on the
  priced grid - the two grids behave alike, which is what was asked.
- **The menus are sectioned** (`MenuList.svelte`: titled sections, icon first, text left-aligned,
  44px rows, arrow/Home/End keys). The card's type menu uses the families above; the card's "..."
  menu holds "Ajouter" (insert a question after this one, duplicate) and "Retirer" (delete). The
  rare settings of a card - "depends on" and the audience condition - fold under **"Plus
  d'options"**, opened by itself when the card already uses one. `FormAdvancedSettings` was left
  as it is: it already groups its settings under titles folded behind "Parametres avances".
- **"Selon" carries an "i"** (`InfoTip.svelte`, a 44px icon button opening a `FloatingSurface`,
  keyboard and touch): a grid varies by ONE criterion; to combine two, make two questions and show
  each according to the other criterion. It appears wherever the priced grid's price section is
  drawn, the wizard's step 2 included.

Tests: `AddQuestionWizard.svelte.test.ts` (step 1 order and alignment, step 2 per type, Ajouter at
the end and after a card, Annuler, Escape, back, the switch both ways), `questionMenus.test.ts`,
`matrixEditor.test.ts`, the "i" in `ProductGridEditor.svelte.test.ts`.

### The responses screen (client half of WP-G4, 2026-11-06)

The `/forms` accordion is now `FormResponsesPanel.svelte`, the owner-approved mockup reproduced with
the app's tokens. Everything is derived from `getSubmissions` (no new read); the rules are pure
functions in `lib/forms/responsesView.ts`.

- **Summary cards**: answers (and how many are a guest's), and on a paid form paid, unpaid cash
  (with the amount still to collect), amount collected (`paid` + `paid_over_capacity`, the money
  that landed) and refunded. **A partial refund leaves its answer `paid` with `totalPaid` whole**
  (only a refund of the whole payment writes `refunded`), so the amount it gave back is read from
  the payment's refund standing (`RefundStanding.refundedCents`) and moved from collected to
  refunded; a manager the refunds list refuses (403) cannot read it, and the card says the amount
  is gross of partial refunds rather than show a net it does not know.
- **"Réponses"**: a search over the name, a guest's reference and every answer's text (case and
  accents folded), and four filter chips - *Toutes*, *Payées* (`paid`, `paid_over_capacity`), *Non
  payées* (`pending_cash`: the unpaid state a manager acts on; an online `pending` is the payer's to
  finish and reads under *Toutes* only), *Remboursées* (`refunded`). The table is
  `FormSubmissionsTable`, which now marks a guest's answer **Invité** (no account on a non-anonymous
  form; its name is the reference it was given), says how a paid answer paid (*Payé · Lydia* /
  *Payé · espèces*), strikes a refunded amount, and draws two row actions: **Marquer payé** on a
  `pending_cash` answer (the existing `validate-cash`) and **Rembourser** on a paid answer of an
  association form, which opens the association's own `RefundDialog` on the payment that paid that
  answer. The purchases list now carries `submissionId` for that; a manager without
  `MANAGE_PRODUCTS` + `MANAGE_PAYOUT_ACCOUNT` gets a 403 there and simply sees no refund control.
- **"Totaux"** (a form with a priced grid): one row x column table per grid with row, column and
  grid totals, a grand total in pieces, and the switch **Compter les réponses non payées** (on by
  default). **The counting rule is ONE implementation**: `PRODUCT_GRID_RECEIVED_STATUSES` (`paid`,
  `free`), `PRODUCT_GRID_AWAITING_CASH_STATUSES` (`pending_cash`), `productGridLinesOf` and
  `productGridTotals` moved into `product-grid-contract.ts` (copied byte for byte), and the export's
  "Totaux" sheet calls the same functions. A refunded, cancelled, expired or still-pending answer is
  in neither list, so it never counts (owner).
- **"Résumé"**: a bar per option of every single choice, multiple choice and dropdown question
  (refunded, cancelled and expired answers left out; a multiple choice counts once per ticked
  option), plus pieces per product on a grid form. **Managers only** (owner): the whole screen is
  - `getSubmissions` answers a form manager and nobody else - and the tab says so.
- **Exporter**: the row's export control is now a menu (`FormExportMenu.svelte`): *Excel* (the
  workbook), and on a grid form *CSV · Articles* and *CSV · Totaux*. A CSV is written by the server
  from the SAME sheet the workbook carries (`GET /forms/:id/export?format=articles-csv|totals-csv`,
  `sheetAsCsv`: `;`-separated with a byte-order mark, which a French spreadsheet opens as columns,
  and every text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return prefixed with
  `'` - a buyer's name or a row label is typed by someone else, and a CSV cell has no type to stop
  a spreadsheet running it as a formula);
  a CSV of a form without a grid is refused `EXPORT_FORMAT_NEEDS_PRODUCT_GRID`, an unknown format
  `EXPORT_FORMAT_UNKNOWN`. `exportLabels()` now sends `productGrid` (16 Paraglide strings) on every
  export, and `refunded` joined `PAYMENT_STATUSES`, so the file names that status in words too.

Tests: `FormResponsesPanel.svelte.test.ts` (filters, search, the guest badge, the cards, the totals
with and without unpaid cash, a closed cell, the bars, the refund control),
`FormExportMenu.svelte.test.ts`, `product-grid-contract.spec.ts` (the counting rule) and
`product-grid-export.spec.ts` (both CSVs read back, both refusals).

## The order bar rests on the bottom of the screen (2026-11-07)

Measured on dev 1.6.6-alpha.4: the grid's order bar (`ProductGridOrderBar`) floated at 65-80 % of the height with the next card visible under it. Cause: `position: sticky; bottom: 0` stops at the scroll container's PADDING edge, and `.page-scroll-wrap` reserved `--bottom-nav-reserve` (4rem + safe area) on every page, including `/f/:id` which renders no bottom navigation. `pageScrollPaddingClass` (`$lib/components/layout/pageScrollPadding.ts`) now applies the reserve only where `routes/+layout.svelte` mounts the app chrome (`!isLoginPage`). The guest wrapper clears the home indicator with `max(0.75rem, var(--safe-area-inset-bottom))`. Inside the app the member page's bar rests on the reserve's edge, and since 2026-11-07 that edge IS the navigation's top (owner: "la coller a la navigation"): the reserve had stayed 4rem after #648 cut the bar to 3rem, so it was 1rem of nothing; both now read `--bottom-nav-height` (`app.css`), the reserve adding the bar's 1px border and the safe area. Pinned by `pageScrollPadding.test.ts` and the wrapper test in `f/[id]/page.productGrid.svelte.test.ts`.
