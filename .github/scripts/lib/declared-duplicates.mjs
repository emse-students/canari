/**
 * THE COPIES THIS REPOSITORY KEEPS ON PURPOSE, AND THE ONE LIST OF THEM.
 *
 * Two gates read this and they ask opposite questions. `declared-duplicates.test.mjs` asks whether
 * every copy in a group still AGREES - a group that drifts is the "three of the four agree" state
 * this repo calls the worst a convention can be in. `undeclared-duplicates.test.mjs` asks the
 * converse: whether a duplicate body it FOUND is one of these, or one nobody decided on.
 *
 * It is one list because the two questions share one answer. A second copy of it would be a
 * declared duplicate of the declared-duplicate list, which is the joke this file exists to avoid.
 *
 * `exact` - byte for byte, comments included. For a file copied wholesale between packages.
 * `code`  - identical once comments and blank lines are dropped. For two files that legitimately
 *           introduce themselves differently but must BEHAVE identically.
 *
 * TO ADD A GROUP: name the files and say WHY they are duplicated rather than shared. To REMOVE
 * one: delete the entry in the same change that deletes the duplication.
 *
 * A COPIED MODULE NEEDS ONE SPEC, NOT ONE PER COPY (WP-TEST-TOOLING-REFORM, 2026-10-21). An
 * `exact` group pins every copy to the same bytes, so a spec run against the FIRST file of the
 * group proves the behaviour of all of them; a byte-identical spec beside each other copy ran the
 * same assertions on the same text and caught nothing more. The spec lives beside the first file,
 * and the copies' specs were deleted. The ONE exception is a spec that builds its input with a
 * dependency each service resolves for itself: `http-error-log.spec.ts` constructs an `AxiosError`
 * from THAT service's `axios`, so each copy of it asks a question the other cannot (does this
 * service's axios produce an error the renderer reads without leaking), and both stay, declared
 * below. Read docs/wiki/test-suite-reform.md, section 7.2, before re-adding a copied spec.
 */
export const DECLARED_GROUPS = [
  {
    what: 'the SIGTERM drain a release relies on to retire a replica without dropping a request',
    compare: 'exact',
    why: 'no shared TS package, for the reason the CORS allowlist below gives; each image must carry the handler itself',
    files: [
      'apps/chat-delivery-service/src/drain-on-sigterm.ts',
      'apps/core-service/src/drain-on-sigterm.ts',
      'apps/media-service/src/drain-on-sigterm.ts',
      'apps/social-service/src/drain-on-sigterm.ts',
    ],
  },
  {
    what: 'the review cohort: which accounts are the store reviewers, the SQL that names them, and the refusal at its boundary',
    compare: 'exact',
    why: 'core-service keeps the cohort apart in search, the directory and profiles; social-service in posts, lives, follows, mentions, the shop and booking spaces; chat-delivery-service in conversations and calls. The three must agree on who is in it, from one secret. No shared TS package, for the reason the CORS allowlist below gives; the file imports only @nestjs/common, which every copy resolves the same. Its spec sits beside the core-service copy.',
    files: [
      'apps/core-service/src/review-cohort.ts',
      'apps/social-service/src/review-cohort.ts',
      'apps/chat-delivery-service/src/review-cohort.ts',
    ],
  },
  {
    what: 'the CORS origin allowlist every service applies',
    compare: 'exact',
    why: 'no shared TS package; one would add a build stage and the --install-links trap to four production images (see the docblock in any copy)',
    files: [
      'apps/chat-delivery-service/src/cors-origins.ts',
      'apps/core-service/src/cors-origins.ts',
      'apps/media-service/src/cors-origins.ts',
      'apps/social-service/src/cors-origins.ts',
    ],
  },
  {
    what: 'the NestJS framework-boot assertion',
    compare: 'exact',
    why: 'each app must assert its OWN resolved tree, so the test has to live in each app; only the assertion is shared',
    files: [
      'apps/chat-delivery-service/src/framework-boot.spec.ts',
      'apps/core-service/src/framework-boot.spec.ts',
      'apps/media-service/src/framework-boot.spec.ts',
      'apps/social-service/src/framework-boot.spec.ts',
    ],
  },
  {
    what: 'the server-to-server secret check every exposed internal route makes',
    compare: 'code',
    why: 'one credential, three services, and no shared TS package - each copy introduces itself with the routes IT gates, which is why this is compared as code rather than exactly',
    files: [
      'apps/core-service/src/internal/internal-secret.util.ts',
      'apps/media-service/src/media/internal-secret.util.ts',
      'apps/social-service/src/internal/internal-secret.util.ts',
    ],
  },
  {
    what: 'the per-user X-Internal-Token HMAC nginx mints, as each auth guard verifies it',
    compare: 'exact',
    why: 'three guards with three DIFFERENT refusal policies (backlog, "THREE SERVICES REFUSE AN UNSIGNED CALLER") share one signature check, and no shared TS package exists to hold it; the policies stay in each guard, only the HMAC is this file',
    files: [
      'apps/chat-delivery-service/src/guards/internal-token.ts',
      'apps/core-service/src/common/guards/internal-token.ts',
      'apps/social-service/src/common/guards/internal-token.ts',
    ],
  },
  {
    what: 'the block check that refuses to pull a blocker into a shared space',
    compare: 'code',
    why: 'the same refusal at two different mutations - a group add and a salon invitation - so each copy names its own call site in prose and must decide identically',
    files: [
      'apps/chat-delivery-service/src/utils/user-blocks.ts',
      'apps/social-service/src/common/user-blocks.ts',
    ],
  },
  {
    what: 'the rendering of a failed outbound HTTP call for a log line, and its spec',
    compare: 'exact',
    why: 'an AxiosError carries the x-internal-secret header of the call; both services call each other and a divergence would let one of them log it again. No shared TS package exists, so the copies and the spec that proves they leak nothing are identical.',
    files: [
      'apps/core-service/src/common/http-error-log.ts',
      'apps/social-service/src/common/http-error-log.ts',
    ],
  },
  {
    what: 'the spec of the failed-call log renderer',
    compare: 'exact',
    why: 'the one copied spec kept on purpose: it builds its AxiosError with the axios THIS service resolved, so each copy proves the no-leak property against its own dependency tree, which a spec run in the other service cannot (see the header of this file)',
    // Read by tools/test-inventory: a copy of this spec is NOT a deletion candidate.
    keepEachCopy: true,
    files: [
      'apps/core-service/src/common/http-error-log.spec.ts',
      'apps/social-service/src/common/http-error-log.spec.ts',
    ],
  },
  {
    what: 'the RFC 5545 primitives, client and server',
    compare: 'exact',
    why: 'a person can export an .ics from the app AND subscribe to the association feed the server serves; the two must describe the same evening - same UID, same UTC stamps, same one-hour default - and no shared TS package exists to hold the rules once',
    files: ['frontend/src/lib/calendar/ics.ts', 'apps/social-service/src/associations/ics.ts'],
  },
  {
    what: 'the Minesweeper engine, client and server',
    compare: 'code',
    why: 'the server replays a ranked game to decide whether a score is a cheat, so it must reach the SAME verdict as the client that produced it - a divergence rejects honest players or accepts dishonest ones',
    files: [
      'frontend/src/lib/minesweeper/game.ts',
      'apps/social-service/src/minesweeper/engine/game.ts',
    ],
  },
  {
    what: 'the one name precedence, on the server side',
    compare: 'exact',
    why: 'one question - "what is this person called" - answered by a push notification title, a ring banner, a member list and a post notification, across two services. A third implementation exists in the frontend and CANNOT be a copy (different runtime, localized fallback), so the two halves of the guarantee are different mechanisms: identical text here, identical ANSWERS through libs/contracts/user-display-name.cases.json, which the two specs (chat-delivery and the frontend) read - the social-service copy is proven by being these bytes. The file declares the minimal row shape itself rather than the model on either side, which is what lets the copies be identical.',
    files: [
      'apps/chat-delivery-service/src/utils/user-display-name.ts',
      'apps/social-service/src/utils/user-display-name.ts',
    ],
  },
  {
    what: "a booking space's wall clock (D25), server and screen",
    compare: 'exact',
    why: "one question - \"what instant is this local time in the space's zone, and back\" - answered by the server for every rule and booking and by the organiser's and booker's screens for every date they show or take, which must not disagree on a DST night. No shared TS package between the NestJS service and the SvelteKit app, and the file has no import, which is what lets the copies be identical.",
    files: [
      'apps/social-service/src/bookings/zoned-time.ts',
      'frontend/src/lib/bookings/zonedTime.ts',
    ],
  },
  {
    what: 'the presence-audience question, validated on both answering services',
    compare: 'exact',
    why: 'the gateway asks chat-delivery (shared conversations) and social-service (shared communities) ONE question, `{ viewerId, userIds }`, and takes the union of the answers - so the two must parse it identically, or one half refuses what the other answers and every presence read is a 503. No shared TS package; the cap is the same number as MAX_PRESENCE_USERS in the gateway, pinned by libs/contracts/presence-audience.cases.json, which the chat-delivery spec and presence.rs read (the social-service copy is these bytes).',
    files: [
      'apps/chat-delivery-service/src/utils/presence-audience.ts',
      'apps/social-service/src/utils/presence-audience.ts',
    ],
  },
  {
    what: "a booking space's booking window (D26), server and screen",
    compare: 'exact',
    why: 'one question - "may this range be booked now" - decided by the server on its own clock and drawn by the grid on the device clock, which must not disagree on a rule or its order. No shared TS package between the NestJS service and the SvelteKit app; the file takes plain numbers rather than either side\'s model, which is what lets the copies be identical, and both specs read libs/contracts/booking-window.cases.json.',
    files: [
      'apps/social-service/src/bookings/booking-window.ts',
      'frontend/src/lib/bookings/bookingWindow.ts',
    ],
  },
  {
    what: 'the reading of a submitted form answer, screen and spreadsheet',
    compare: 'exact',
    why: 'one question - "what did this person answer" - asked by the responses table and by the XLSX export an hour later, and those two must not be able to disagree. No shared TS package, and the file declares the minimal question shape itself rather than the model on either side, which is what lets the copies be identical.',
    files: ['frontend/src/lib/forms/answerText.ts', 'apps/social-service/src/forms/answer-text.ts'],
  },
];

/**
 * Shared idioms that are NOT shared decisions, and which extracting would make worse.
 *
 * A group belongs here only when the two copies would still have to be read together after the
 * extraction - when the thing they have in common is a SHAPE, not a rule. Clearing a timer you
 * own is that: a helper named `clearLongPressTimer` imported by two unrelated components would
 * have to take the timer as an argument and give it back, which is longer than the four lines it
 * replaces and makes each component's own state readable from somewhere else.
 *
 * THE BAR IS DELIBERATELY HIGHER THAN FOR A DECLARED GROUP. A declared group says "these must
 * agree"; an entry here says "these agreeing means nothing", so it must say why a divergence
 * would be HARMLESS. If a divergence would be a defect, it is a declared group instead.
 */
export const ACKNOWLEDGED_IDIOMS = [
  {
    what: 'clearing a long-press timer the component owns',
    why: 'the shape is shared, the decision is not - one cancels a message action sheet, the other a Minesweeper flag, and neither would be wrong if the other changed. Extracting it would hand each component its own state back through an argument.',
    files: [
      'frontend/src/lib/components/messages/MessageBubble.svelte',
      'frontend/src/lib/components/settings/MinesweeperModal.svelte',
    ],
  },
];
