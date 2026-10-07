import { withSubmissionReturnKey } from './return-url-key';

describe('withSubmissionReturnKey', () => {
  const id = 'd1f769ce-6cb6-47b8-b20b-7636f59548da';

  it('replaces the Stripe placeholder on a web return URL', () => {
    expect(
      withSubmissionReturnKey(
        'https://dev.canari-emse.fr/forms/success?session_id={CHECKOUT_SESSION_ID}',
        id
      )
    ).toBe(`https://dev.canari-emse.fr/forms/success?submission_id=${id}`);
  });

  it('replaces it on a mobile deep link too', () => {
    expect(
      withSubmissionReturnKey('fr.emse.canari://stripe/cancel?session_id={CHECKOUT_SESSION_ID}', id)
    ).toBe(`fr.emse.canari://stripe/cancel?submission_id=${id}`);
  });

  it('leaves a URL without the placeholder untouched', () => {
    expect(withSubmissionReturnKey('https://x.example/shop?purchase_cancel=1', id)).toBe(
      'https://x.example/shop?purchase_cancel=1'
    );
  });
});
