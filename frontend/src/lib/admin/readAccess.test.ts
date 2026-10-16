import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  READ_GRANT_JOURNAL_PAGE,
  cellKey,
  grantees,
  groupGrantsByCampus,
  journalCountLabel,
  reviewerJournal,
} from './readAccess';

// Kept in a variable: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL.
const SERVICE_REL = '../../../../apps/social-service/src/read-grants/read-grants.service.ts';
import type { ReadGrant } from '$lib/associations/api';

const grant = (userId: string, campus: string, formation: string | null): ReadGrant => ({
  userId,
  campus,
  formation,
  grantedBy: 'admin',
  createdAt: '2026-10-16T10:00:00Z',
});

afterEach(() => vi.restoreAllMocks());

describe('groupGrantsByCampus', () => {
  it('groups by campus in campus order, whole campus first, formations in their order', () => {
    const groups = groupGrantsByCampus([
      grant('u', 'gardanne', 'ISMIN'),
      grant('u', 'saint-etienne', 'PDIS'),
      grant('u', 'gardanne', null),
      grant('u', 'saint-etienne', 'ICM'),
    ]);
    expect(groups).toEqual([
      { campus: 'saint-etienne', scopes: ['ICM', 'PDIS'] },
      { campus: 'gardanne', scopes: [null, 'ISMIN'] },
    ]);
  });

  it('leaves out a campus with nothing held, and a cell this client does not know (with a warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(groupGrantsByCampus([grant('u', 'paris', null)])).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('the journal count', () => {
  it('is the line count, or "<page>+" for a full page', () => {
    expect(journalCountLabel(0)).toBe('0');
    expect(journalCountLabel(199)).toBe('199');
    expect(journalCountLabel(200)).toBe('200+');
  });

  it('uses the page size the server actually returns', () => {
    const service = readFileSync(fileURLToPath(new URL(SERVICE_REL, import.meta.url)), 'utf8');
    expect(service).toMatch(new RegExp(`export const JOURNAL_PAGE = ${READ_GRANT_JOURNAL_PAGE};`));
  });
});

it('cellKey names the whole campus with a star', () => {
  expect(cellKey('u', 'gardanne', null)).toBe('u|gardanne|*');
  expect(cellKey('u', 'gardanne', 'ICM')).toBe('u|gardanne|ICM');
});

it('grantees keeps the order people first appear in', () => {
  expect(
    grantees([
      grant('b', 'gardanne', null),
      grant('a', 'gardanne', null),
      grant('b', 'gardanne', 'ICM'),
    ])
  ).toEqual(['b', 'a']);
});

it('reviewerJournal is newest first, one line per grant in force', () => {
  const lines = reviewerJournal([
    { userId: 'old', grantedBy: 'x', createdAt: '2026-01-01T00:00:00Z' },
    { userId: 'new', grantedBy: 'y', createdAt: '2026-10-01T00:00:00Z' },
  ]);
  expect(lines.map((l) => [l.userId, l.actor])).toEqual([
    ['new', 'y'],
    ['old', 'x'],
  ]);
});
