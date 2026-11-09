import { readFileSync } from 'fs';
import { join } from 'path';
import { chargesMoney } from './forms.service';
import { publishPaymentRefusal } from './payment-offer';

/**
 * Whether a form charges, and why its publication is refused: the cases in
 * `libs/contracts/form-publish-payment.cases.json`, which the editor's `publish.test.ts` reads too -
 * the screen that shuts "Publier" and the server that refuses it cannot disagree.
 */
interface PublishCase {
  name: string;
  form: Record<string, unknown>;
  onlineReady: boolean;
  charges: boolean;
  expected: string | null;
}

const { cases } = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'form-publish-payment.cases.json'),
    'utf8'
  )
) as { cases: PublishCase[] };

describe('the publication of a paid form, as libs/contracts/form-publish-payment.cases.json says', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const form = c.form as never;
    expect(chargesMoney(form)).toBe(c.charges);
    const refusal = chargesMoney(form)
      ? await publishPaymentRefusal(form, async () => c.onlineReady)
      : null;
    expect(refusal).toBe(c.expected);
  });
});
