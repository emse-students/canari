import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ApiRefusalError } from './apiRefusalError';
import { refusalCode } from './apiRefusal';
import { TYPED_ELSEWHERE_CODES, WORDED_REFUSAL_CODES, describeRefusalCode } from './refusalCodes';

/** The keys of the `RefusalCode = { ... } as const` table of one server registry. */
function serverCodes(relativePath: string): string[] {
  const source = readFileSync(join(process.cwd(), '..', relativePath), 'utf8');
  const table = /export const RefusalCode = \{([\s\S]*?)\} as const;/.exec(source);
  expect(table, `${relativePath} declares no RefusalCode table`).not.toBeNull();
  return [...table![1].matchAll(/^\s+([A-Z_]+):/gm)].map((hit) => hit[1]);
}

const REGISTRIES = [
  'apps/chat-delivery-service/src/utils/refusal-codes.ts',
  'apps/core-service/src/common/refusal-codes.ts',
];

describe('refusal codes - the client words what the server names', () => {
  it('words every code a server registry carries, or declares it typed elsewhere', () => {
    const named = new Set([...WORDED_REFUSAL_CODES, ...TYPED_ELSEWHERE_CODES]);
    const forgotten = REGISTRIES.flatMap(serverCodes).filter((code) => !named.has(code));
    expect(forgotten).toEqual([]);
  });

  it('never words a code no server registry carries', () => {
    const served = new Set(REGISTRIES.flatMap(serverCodes));
    const stale = [...WORDED_REFUSAL_CODES, ...TYPED_ELSEWHERE_CODES].filter(
      (code) => !served.has(code)
    );
    expect(stale).toEqual([]);
  });

  it('gives every worded code a non-empty sentence that is not the code itself', () => {
    for (const code of WORDED_REFUSAL_CODES) {
      const sentence = describeRefusalCode(code);
      expect(sentence, code).toBeTruthy();
      expect(sentence, code).not.toBe(code);
    }
  });

  it('answers null for no code, an unknown code and an inherited property name', () => {
    expect(describeRefusalCode(null)).toBeNull();
    expect(describeRefusalCode('NOT_A_CODE')).toBeNull();
    expect(describeRefusalCode('toString')).toBeNull();
  });

  it('reads the code off a typed refusal, never off its message', () => {
    const error = new ApiRefusalError(403, 'PIN_INCORRECT', 'current PIN is incorrect');
    expect(describeRefusalCode(refusalCode(error))).not.toContain('current PIN is incorrect');
    expect(describeRefusalCode(refusalCode(error))).toBeTruthy();
  });
});
