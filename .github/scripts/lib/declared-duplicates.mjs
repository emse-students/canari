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
 */
export const DECLARED_GROUPS = [
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
    what: 'the CORS allowlist test that guards it',
    compare: 'exact',
    why: 'a copied module needs a copied test beside it, or three services assert the behaviour and the fourth only inherits the file',
    files: [
      'apps/chat-delivery-service/src/cors-origins.spec.ts',
      'apps/core-service/src/cors-origins.spec.ts',
      'apps/media-service/src/cors-origins.spec.ts',
      'apps/social-service/src/cors-origins.spec.ts',
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
    what: 'the block check that refuses to pull a blocker into a shared space',
    compare: 'code',
    why: 'the same refusal at two different mutations - a group add and a salon invitation - so each copy names its own call site in prose and must decide identically',
    files: [
      'apps/chat-delivery-service/src/utils/user-blocks.ts',
      'apps/social-service/src/common/user-blocks.ts',
    ],
  },
  {
    what: 'the Stripe callback URL allowlist',
    compare: 'exact',
    why: 'an allowlist deciding where a payment may return to; two services build those URLs and a divergence would let one accept a destination the other refuses',
    files: [
      'apps/core-service/src/payment/stripe-callback-url.ts',
      'apps/social-service/src/common/stripe-callback-url.ts',
    ],
  },
  {
    what: 'the RFC 5545 primitives, client and server',
    compare: 'exact',
    why: 'a person can export an .ics from the app AND subscribe to the association feed the server serves; the two must describe the same evening - same UID, same UTC stamps, same one-hour default - and no shared TS package exists to hold the rules once',
    files: [
      'frontend/src/lib/calendar/ics.ts',
      'apps/social-service/src/associations/ics.ts',
    ],
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
