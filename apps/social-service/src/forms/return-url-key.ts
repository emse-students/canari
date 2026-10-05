/**
 * Stripe fills `{CHECKOUT_SESSION_ID}` into a return URL when it redirects; Lydia does not, so the
 * page would receive the literal braces and could never find the payment. The submission id is
 * known BEFORE the request is created, and the signed callback is what marks it paid, so for Lydia
 * the return URL carries that instead and the page asks the submission.
 */
export function withSubmissionReturnKey(url: string, submissionId: string): string {
  return url.replace(
    'session_id={CHECKOUT_SESSION_ID}',
    `submission_id=${encodeURIComponent(submissionId)}`
  );
}
