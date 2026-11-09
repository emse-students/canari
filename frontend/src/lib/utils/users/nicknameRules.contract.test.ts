import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NICKNAME_MAX_LENGTH, NICKNAME_TOO_LONG, normalizeNickname } from './nicknameRules';

/**
 * ONE CONTRACT, READ FROM DISK: social-service's spec walks the same file, so the client that writes
 * an MLS frame and the server that writes a community's column cannot hold a nickname to two rules.
 */
interface ContractCase {
  input: string;
  expected?: string | null;
  error?: string;
}

const CONTRACT: { maxLength: number; tooLongCode: string; cases: ContractCase[] } = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'libs',
      'contracts',
      'conversation-nickname.json'
    ),
    'utf8'
  )
);

describe('normalizeNickname - libs/contracts/conversation-nickname.json', () => {
  it('states the same limit and refusal code as the contract', () => {
    expect(NICKNAME_MAX_LENGTH).toBe(CONTRACT.maxLength);
    expect(NICKNAME_TOO_LONG).toBe(CONTRACT.tooLongCode);
  });

  for (const c of CONTRACT.cases) {
    it(`normalizes ${JSON.stringify(c.input).slice(0, 40)}`, () => {
      const result = normalizeNickname(c.input);
      if (c.error) {
        expect(result).toEqual({ ok: false, code: c.error });
      } else {
        expect(result).toEqual({ ok: true, value: c.expected ?? null });
      }
    });
  }
});
