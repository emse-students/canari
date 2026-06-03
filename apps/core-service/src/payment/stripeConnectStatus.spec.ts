import {
  buildStripeConnectStatusResponse,
  deriveStripeConnectStatus,
} from './stripeConnectStatus';

describe('deriveStripeConnectStatus', () => {
  it('returns not_started when no account id is handled upstream', () => {
    expect(
      deriveStripeConnectStatus({
        charges_enabled: false,
        details_submitted: false,
      }),
    ).toBe('onboarding_required');
  });

  it('returns active when charges are enabled', () => {
    expect(
      deriveStripeConnectStatus({
        charges_enabled: true,
        details_submitted: true,
      }),
    ).toBe('active');
  });

  it('returns onboarding_required when details are missing', () => {
    expect(
      deriveStripeConnectStatus({
        charges_enabled: false,
        details_submitted: false,
        requirements: { currently_due: [], pending_verification: [] },
      }),
    ).toBe('onboarding_required');
  });

  it('returns onboarding_required when Stripe lists currently_due fields', () => {
    expect(
      deriveStripeConnectStatus({
        charges_enabled: false,
        details_submitted: true,
        requirements: {
          currently_due: ['individual.verification.document'],
          pending_verification: [],
        },
      }),
    ).toBe('onboarding_required');
  });

  it('returns pending when submitted and under Stripe review', () => {
    expect(
      deriveStripeConnectStatus({
        charges_enabled: false,
        details_submitted: true,
        requirements: {
          currently_due: [],
          pending_verification: ['individual.verification.document'],
        },
      }),
    ).toBe('pending');
  });

  it('returns pending when submitted but charges not yet enabled', () => {
    expect(
      deriveStripeConnectStatus({
        charges_enabled: false,
        details_submitted: true,
        requirements: { currently_due: [], pending_verification: [] },
      }),
    ).toBe('pending');
  });

  it('returns restricted when disabled_reason is set', () => {
    expect(
      deriveStripeConnectStatus({
        charges_enabled: false,
        requirements: { disabled_reason: 'rejected.fraud' },
      }),
    ).toBe('restricted');
  });
});

describe('buildStripeConnectStatusResponse', () => {
  it('includes requirement arrays in the payload', () => {
    const res = buildStripeConnectStatusResponse({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements: {
        currently_due: [],
        pending_verification: ['individual.id_number'],
      },
    });
    expect(res.status).toBe('pending');
    expect(res.pendingVerification).toEqual(['individual.id_number']);
  });
});
