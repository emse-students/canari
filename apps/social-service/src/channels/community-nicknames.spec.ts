import { readFileSync } from 'fs';
import { join } from 'path';
import {
  mayWriteCommunityNickname,
  NICKNAME_MAX_LENGTH,
  NICKNAME_TOO_LONG,
  nicknameReportSubject,
  normalizeNickname,
  parseNicknameReportSubject,
} from './community-nicknames';

/**
 * The server's half of `libs/contracts/conversation-nickname.json`: the frontend's
 * `nicknameRules.contract.test.ts` walks the same cases, so an MLS frame and a community column
 * cannot hold a nickname to two rules.
 */
interface ContractCase {
  input: string;
  expected?: string | null;
  error?: string;
}

const CONTRACT: { maxLength: number; tooLongCode: string; cases: ContractCase[] } = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'conversation-nickname.json'),
    'utf8'
  )
);

describe('normalizeNickname - the shared contract', () => {
  it('states the same limit and refusal code', () => {
    expect(NICKNAME_MAX_LENGTH).toBe(CONTRACT.maxLength);
    expect(NICKNAME_TOO_LONG).toBe(CONTRACT.tooLongCode);
  });

  it.each(CONTRACT.cases.map((c) => [JSON.stringify(c.input).slice(0, 40), c] as const))(
    'normalizes %s',
    (_label, c) => {
      const expected = c.error
        ? { ok: false, code: c.error }
        : { ok: true, value: c.expected ?? null };
      expect(normalizeNickname(c.input)).toEqual(expected);
    }
  );

  it('reads anything that is not a string as a reset', () => {
    expect(normalizeNickname(null)).toEqual({ ok: true, value: null });
    expect(normalizeNickname(42)).toEqual({ ok: true, value: null });
  });
});

describe('mayWriteCommunityNickname', () => {
  it('lets a moderator name anybody', () => {
    expect(
      mayWriteCommunityNickname({ actorIsTarget: false, isReset: false, actorCanModerate: true })
    ).toBe(true);
  });

  it('lets a member clear their own nickname, and nothing else', () => {
    const m = (actorIsTarget: boolean, isReset: boolean) =>
      mayWriteCommunityNickname({ actorIsTarget, isReset, actorCanModerate: false });
    expect(m(true, true)).toBe(true);
    expect(m(true, false)).toBe(false);
    expect(m(false, true)).toBe(false);
    expect(m(false, false)).toBe(false);
  });
});

describe('the report subject of one nickname version', () => {
  const row = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('round-trips', () => {
    expect(parseNicknameReportSubject(nicknameReportSubject(row, 1730000000123))).toEqual({
      memberRowId: row,
      setAtMs: 1730000000123,
    });
  });

  it('refuses anything else', () => {
    expect(parseNicknameReportSubject(row)).toBeNull();
    expect(parseNicknameReportSubject(`${row}@`)).toBeNull();
    expect(parseNicknameReportSubject(`${row}@12x`)).toBeNull();
    expect(parseNicknameReportSubject(`x@1`)).toBeNull();
  });
});
