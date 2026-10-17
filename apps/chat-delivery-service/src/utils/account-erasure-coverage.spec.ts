import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_ERASURE_COVERAGE } from './account-erasure-coverage';

/**
 * EVERY COLUMN THAT CAN NAME AN ACCOUNT HAS A DISPOSITION, OR THIS FAILS.
 *
 * Four tables were missing from the account erasure for months because the handler was a list
 * written by hand and nothing compared it with the schema. This reads the schema - every
 * `*.entity.ts` - and the shared definition of "a column that holds an account id"
 * (`libs/contracts/account-reference-columns.json`, also read by social-service), and asserts the
 * two agree in both directions: nothing unclassified, nothing classified that no longer exists.
 * Source parsing rather than TypeORM metadata, because building the metadata needs a DataSource and
 * the assertion is about what the files say.
 */
const contract = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'account-reference-columns.json'),
    'utf8'
  )
) as { pattern: string; excludeSuffixes: string[] };

const ENTITIES = join(__dirname, '..', 'entities');

/** `Entity.property` for every column of every entity whose name matches the contract. */
function accountReferences(): string[] {
  const pattern = new RegExp(contract.pattern, 'i');
  const out: string[] = [];
  for (const file of readdirSync(ENTITIES).filter((f) => f.endsWith('.entity.ts'))) {
    const source = readFileSync(join(ENTITIES, file), 'utf8');
    const entity = /export class (\w+)/.exec(source)?.[1];
    if (!entity) continue;
    // A property declaration directly under a column decorator (possibly after an @Index).
    const props = source.matchAll(/@(?:Primary)?(?:Generated)?Column[\s\S]*?\n\s+(\w+)[!?]?:/g);
    for (const [, prop] of props) {
      if (!pattern.test(prop)) continue;
      if (contract.excludeSuffixes.some((s) => prop.endsWith(s))) continue;
      out.push(`${entity}.${prop}`);
    }
  }
  return [...new Set(out)].sort();
}

describe('account erasure coverage (chat-delivery)', () => {
  const found = accountReferences();

  it('finds the columns it is meant to find, so an empty scan cannot pass', () => {
    expect(found).toEqual(expect.arrayContaining(['KeyPackage.userId', 'QueuedMessage.senderId']));
  });

  it('gives every account-naming column a disposition', () => {
    const missing = found.filter((c) => !(c in ACCOUNT_ERASURE_COVERAGE));
    expect(missing).toEqual([]);
  });

  it('classifies nothing that is not a column any more', () => {
    const stale = Object.keys(ACCOUNT_ERASURE_COVERAGE).filter((c) => !found.includes(c));
    expect(stale).toEqual([]);
  });

  it('gives every kept column its reason', () => {
    const shortReasons = Object.entries(ACCOUNT_ERASURE_COVERAGE).filter(
      ([, d]) => d.action === 'kept' && d.reason.length <= 20
    );
    expect(shortReasons).toEqual([]);
  });
});
