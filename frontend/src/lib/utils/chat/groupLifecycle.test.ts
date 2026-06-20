import { describe, it, expect } from 'vitest';
import {
  classifyServerStatus,
  decideAbsentGroupFate,
  type AbsentGroupFateInput,
  type ConversationLifecycle,
  type GroupServerStatus,
} from './groupLifecycle';
import type { GroupMeta } from '$lib/mls-client/IMlsService';

describe('classifyServerStatus', () => {
  it("'absent' -> kind absent", () => {
    expect(classifyServerStatus('absent')).toEqual({ kind: 'absent' });
  });

  it("'error' -> kind unknown (doute reseau)", () => {
    expect(classifyServerStatus('error')).toEqual({ kind: 'unknown' });
  });

  it('GroupMeta sans deletedAt -> active', () => {
    const meta: GroupMeta = { groupId: 'g1', name: 'Equipe', deletedAt: null };
    expect(classifyServerStatus(meta)).toEqual({ kind: 'active', meta });
  });

  it('GroupMeta avec deletedAt -> tombstone', () => {
    const meta: GroupMeta = { groupId: 'g1', deletedAt: '2026-06-20T00:00:00Z' };
    expect(classifyServerStatus(meta)).toEqual({ kind: 'tombstone', meta });
  });
});

describe('decideAbsentGroupFate', () => {
  const base: AbsentGroupFateInput = {
    isKnownSuccessor: false,
    lifecycle: 'active',
    serverStatus: { kind: 'absent' },
    isStillUserMember: null,
  };
  const make = (o: Partial<AbsentGroupFateInput>): AbsentGroupFateInput => ({ ...base, ...o });
  const active = (): GroupServerStatus => ({ kind: 'active', meta: { groupId: 'g1' } });
  const tombstone = (): GroupServerStatus => ({
    kind: 'tombstone',
    meta: { groupId: 'g1', deletedAt: '2026-06-20T00:00:00Z' },
  });

  // ── Gardes prioritaires (court-circuitent l'etat serveur) ──
  it('successeur tombstone connu -> keep (meme si serveur absent)', () => {
    expect(decideAbsentGroupFate(make({ isKnownSuccessor: true })).action).toBe('keep');
  });

  it('deja removed -> keep (suppression manuelle, jamais re-purge)', () => {
    expect(decideAbsentGroupFate(make({ lifecycle: 'removed' })).action).toBe('keep');
  });

  it('removed a la priorite meme sur un serveur absent', () => {
    const fate = decideAbsentGroupFate(
      make({ lifecycle: 'removed', serverStatus: { kind: 'absent' } })
    );
    expect(fate.action).toBe('keep');
  });

  // ── absent confirme ──
  it('absent confirme -> purge', () => {
    expect(decideAbsentGroupFate(make({ serverStatus: { kind: 'absent' } })).action).toBe('purge');
  });

  // ── doute reseau ──
  it('unknown (reseau) -> keep (jamais de purge sur un doute)', () => {
    expect(decideAbsentGroupFate(make({ serverStatus: { kind: 'unknown' } })).action).toBe('keep');
  });

  // ── tombstone ──
  it('tombstone + active -> markRemoved (banniere)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: tombstone(), lifecycle: 'active' })).action
    ).toBe('markRemoved');
  });

  it('tombstone + placeholder (pending) -> keep', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: tombstone(), lifecycle: 'pending' })).action
    ).toBe('keep');
  });

  // ── active (anti-race membership) ──
  it('active + membres indisponibles (null) -> keep (doute)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: active(), isStillUserMember: null })).action
    ).toBe('keep');
  });

  it('active + toujours membre -> keep (snapshot perime)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: active(), isStillUserMember: true })).action
    ).toBe('keep');
  });

  it('active + plus membre + lifecycle active -> markRemoved (exclusion)', () => {
    expect(
      decideAbsentGroupFate(
        make({ serverStatus: active(), isStillUserMember: false, lifecycle: 'active' })
      ).action
    ).toBe('markRemoved');
  });

  it('active + plus membre + placeholder (pending) -> keep', () => {
    expect(
      decideAbsentGroupFate(
        make({ serverStatus: active(), isStillUserMember: false, lifecycle: 'pending' })
      ).action
    ).toBe('keep');
  });

  // ── Invariant cle : jamais de purge sur autre chose qu'un absent confirme ──
  it('seul un absent confirme produit purge (jamais tombstone/active/unknown)', () => {
    const nonAbsent: GroupServerStatus[] = [active(), tombstone(), { kind: 'unknown' }];
    const lifecycles: ConversationLifecycle[] = ['active', 'pending', 'removed'];
    for (const serverStatus of nonAbsent) {
      for (const lifecycle of lifecycles) {
        for (const isStillUserMember of [true, false, null]) {
          const fate = decideAbsentGroupFate(make({ serverStatus, lifecycle, isStillUserMember }));
          expect(fate.action).not.toBe('purge');
        }
      }
    }
  });
});
