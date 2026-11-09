/**
 * The review cohort an integration spec runs with, set BEFORE `reader-spaces.ts` is imported.
 *
 * Some fragments of that module are constants built at import (`IN_FEED_AUDIENCE_SQL`), and they
 * read `SERVICE_ACCOUNT_USER_ID` then, as production does at boot. Imports are evaluated in the
 * order they are written, so a spec imports this file FIRST and every fragment sees the cohort.
 * `tsconfig.build.json` leaves it out of the image, as it does every spec.
 */
export const REVIEW_A = 'a1'.repeat(32);
export const REVIEW_B = 'b2'.repeat(32);

process.env.SERVICE_ACCOUNT_USER_ID = `${REVIEW_A},${REVIEW_B}`;
