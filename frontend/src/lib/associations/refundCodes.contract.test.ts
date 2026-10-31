/**
 * The refund codes this screen words are the ones in `libs/contracts/lydia-refusal-codes.json`
 * (section `refund`), which core-service and social-service assert too - so a rename on one side
 * fails a test on the other.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUND_CORE_CODES, REFUND_SOCIAL_CODES, refundRefusalMessage } from './refundWording';

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'lydia-refusal-codes.json'),
    'utf8'
  )
) as {
  refund: {
    core: Record<string, string>;
    social: Record<string, string>;
    notificationTypes: { issued: string };
  };
};

describe('refund codes follow the shared contract', () => {
  it('the social and core codes are the contract ones', () => {
    expect(REFUND_SOCIAL_CODES).toEqual(CONTRACT.refund.social);
    expect(REFUND_CORE_CODES).toEqual(CONTRACT.refund.core);
  });

  it('every code but the unconfirmed one is worded, never shown raw', () => {
    for (const code of [
      ...Object.values(CONTRACT.refund.social),
      ...Object.values(CONTRACT.refund.core),
    ]) {
      if (code === CONTRACT.refund.core.unconfirmed) continue;
      const message = refundRefusalMessage(code);
      expect(message, code).toBeTruthy();
      expect(message, code).not.toContain(code);
    }
  });

  it('the payer notice type is the contract one', async () => {
    const { isKnownNotificationType } = await import('$lib/posts/notificationTarget');
    expect(isKnownNotificationType(CONTRACT.refund.notificationTypes.issued)).toBe(true);
  });
});
