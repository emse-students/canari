/**
 * Every client at the floor sends its return URL with a `session_id={CHECKOUT_SESSION_ID}`
 * placeholder (a token the processor before Lydia filled in, docs/wiki/stripe-archive.md); Lydia
 * fills in nothing, so the page would receive the literal braces and could never find the payment.
 * The submission id is known BEFORE the request is created, and the signed callback is what marks
 * it paid, so for Lydia the return URL carries that instead and the page asks the submission.
 */
export function withSubmissionReturnKey(url: string, submissionId: string): string {
  return url.replace(
    'session_id={CHECKOUT_SESSION_ID}',
    `submission_id=${encodeURIComponent(submissionId)}`
  );
}
