/**
 * The client's half of `libs/contracts/leaf-identity.cases.json`, also run by chat-delivery-service's
 * `sanitize.leaf-identity.spec.ts` - so the client never sends a leaf the server would skip, and
 * never withholds one it would answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADDRESSABLE_HALF, isAddressableLeafIdentity } from './leafIdentity';

interface LeafCase {
  name: string;
  identity: string;
}

// Relative to this file inside the monorepo: the contract lives at its root, outside the package.
const ROOT = join(__dirname, '..', '..', '..', '..');
const CONTRACT = JSON.parse(
  readFileSync(join(ROOT, 'libs', 'contracts', 'leaf-identity.cases.json'), 'utf8')
) as { accept: LeafCase[]; reject: LeafCase[] };
const DEVICE_ID = JSON.parse(
  readFileSync(join(ROOT, 'libs', 'contracts', 'device-id.json'), 'utf8')
) as { pattern: string };

describe('the leaf identity contract, client side', () => {
  it.each(CONTRACT.accept.map((c) => [c.name, c.identity]))('sends %s', (_name, identity) => {
    expect(isAddressableLeafIdentity(identity)).toBe(true);
  });

  it.each(CONTRACT.reject.map((c) => [c.name, c.identity]))('withholds %s', (_name, identity) => {
    expect(isAddressableLeafIdentity(identity)).toBe(false);
  });

  it('bounds each half by the device-id contract: 128 passes, 129 does not', () => {
    expect(ADDRESSABLE_HALF.source).toBe(DEVICE_ID.pattern);
    expect(isAddressableLeafIdentity(`${'u'.repeat(128)}:d`)).toBe(true);
    expect(isAddressableLeafIdentity(`${'u'.repeat(129)}:d`)).toBe(false);
  });
});
