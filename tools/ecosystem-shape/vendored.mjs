/**
 * WHAT IS COPIED BYTE-IDENTICALLY FROM CANARI INTO A SIBLING, and where the copy lives. Data only,
 * so `shape.mjs` (which needs the four checkouts side by side) and a test that needs none read the
 * same table. A site joins a table in the pull request that vendors the file.
 */

/** The sign-in handoff (design note on the sign-in handoff, section 4). MiGallery first, Sky with WP-H6. */
export const HANDOFF_VENDORED = [
  ['libs/handoff/handoff-verify.ts', { MiGallery: 'src/lib/server/handoff/handoff-verify.ts' }],
  ['libs/handoff/handoff-landing.ts', { MiGallery: 'src/lib/handoff/handoff-landing.ts' }],
  ['libs/contracts/handoff-token.cases.json', { MiGallery: 'tests/fixtures/handoff-token.cases.json' }],
];

/**
 * The Alumni merge call's verifier (Canari's profiles-and-access.md, D54): each MiConnect site copies
 * it BESIDE its `handoff-verify.ts`, whose leeway and lifetime it imports (`./handoff-verify.js`) -
 * `src/lib/server/handoff/alumni-merge-verify.ts` in Sky and MiGallery. A site joins in the pull
 * request that vendors it; Le Cercle is on GitLab, outside this tool, and holds its copy by its own test.
 */
export const ALUMNI_MERGE_VENDORED = [['libs/handoff/alumni-merge-verify.ts', {}]];

/**
 * The Meta in-app browser gate (owner decision of 2026-11-25, docs/wiki/frontend/leaving-in-app-browsers.md
 * section 6): the detector, the server gate, the interstitial and the user-agent fixtures, in Sky,
 * MiGallery and Portail-etu. Le Cercle is on GitLab, outside this tool, and holds its copies by a
 * pinned hash in its own CI.
 */
const LEAVE_IAB_SITES = ['Sky', 'MiGallery', 'Portail-etu'];
const LEAVE_IAB_FILES = [
  ['detect.ts', 'src/lib/leaveInAppBrowser/detect.ts'],
  ['gate.ts', 'src/lib/leaveInAppBrowser/gate.ts'],
  ['interstitial.html', 'src/lib/leaveInAppBrowser/interstitial.html'],
  ['fixtures.json', 'tests/fixtures/leave-in-app-browser.fixtures.json'],
];
export const LEAVE_IAB_VENDORED = LEAVE_IAB_FILES.map(([name, path]) => [
  `libs/leave-in-app-browser/${name}`,
  Object.fromEntries(LEAVE_IAB_SITES.map((site) => [site, path])),
]);
