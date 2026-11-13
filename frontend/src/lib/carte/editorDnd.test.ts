import { describe, expect, it } from 'vitest';
import {
  decodeDrag,
  encodeDrag,
  groupAssociationsByZone,
  moveZoneId,
  planAssociationDrop,
  planDrop,
  planZoneReorder,
} from './editorDnd';

describe('drag payload', () => {
  it('round-trips and refuses anything foreign', () => {
    expect(decodeDrag(encodeDrag({ kind: 'zone', id: 'z1' }))).toEqual({ kind: 'zone', id: 'z1' });
    expect(decodeDrag('not json')).toBeNull();
    expect(decodeDrag('{"kind":"file","id":"x"}')).toBeNull();
    expect(decodeDrag('{"kind":"asso","id":""}')).toBeNull();
    expect(decodeDrag(null)).toBeNull();
  });
});

describe('planAssociationDrop', () => {
  const zoneOf = { a: 'z1', b: null };
  it('assigns the dropped association to the zone', () => {
    expect(planAssociationDrop({ kind: 'asso', id: 'b' }, 'z1', zoneOf)).toEqual({
      associationId: 'b',
      zoneId: 'z1',
    });
  });
  it('a drop onto the no-zone group clears the zone', () => {
    expect(planAssociationDrop({ kind: 'asso', id: 'a' }, null, zoneOf)).toEqual({
      associationId: 'a',
      zoneId: null,
    });
  });
  it('writes nothing for a no-op, a zone drag or an unknown association', () => {
    expect(planAssociationDrop({ kind: 'asso', id: 'a' }, 'z1', zoneOf)).toBeNull();
    expect(planAssociationDrop({ kind: 'asso', id: 'b' }, null, zoneOf)).toBeNull();
    expect(planAssociationDrop({ kind: 'zone', id: 'z1' }, 'z1', zoneOf)).toBeNull();
    expect(planAssociationDrop({ kind: 'asso', id: 'ghost' }, 'z1', zoneOf)).toBeNull();
    expect(planAssociationDrop(null, 'z1', zoneOf)).toBeNull();
  });
});

describe('planZoneReorder', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('takes the target slot, down and up', () => {
    expect(planZoneReorder(ids, { kind: 'zone', id: 'a' }, 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(planZoneReorder(ids, { kind: 'zone', id: 'd' }, 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('is null when nothing moves or the drag is not a known zone', () => {
    expect(planZoneReorder(ids, { kind: 'zone', id: 'a' }, 'a')).toBeNull();
    expect(planZoneReorder(ids, { kind: 'asso', id: 'a' }, 'b')).toBeNull();
    expect(planZoneReorder(ids, { kind: 'zone', id: 'x' }, 'b')).toBeNull();
    expect(planZoneReorder(ids, { kind: 'zone', id: 'a' }, 'x')).toBeNull();
  });
  it('does not mutate its input', () => {
    planZoneReorder(ids, { kind: 'zone', id: 'a' }, 'd');
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('moveZoneId (the keyboard path)', () => {
  it('moves one step and stops at the ends', () => {
    expect(moveZoneId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveZoneId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveZoneId(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(moveZoneId(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(moveZoneId(['a'], 'x', 1)).toBeNull();
  });
});

describe('groupAssociationsByZone', () => {
  const assos = [
    { id: '1', name: 'Zeta' },
    { id: '2', name: 'Alpha' },
    { id: '3', name: 'Mid' },
    { id: '4', name: 'Orphan' },
  ];
  it('buckets by zone, no-zone first, new first then by name', () => {
    const groups = groupAssociationsByZone(
      assos,
      ['z1', 'z2'],
      { '1': 'z1', '2': 'z1', '3': null, '4': 'deleted' },
      new Set(['1'])
    );
    expect(groups.map((g) => [g.zoneId, g.items.map((a) => a.id)])).toEqual([
      [null, ['3', '4']],
      ['z1', ['1', '2']],
      ['z2', []],
    ]);
  });
});

describe('planDrop - what the page writes for a drop', () => {
  const zoneIds = ['z1', 'z2'];
  const zoneOf = { a: null, b: 'z1' };
  it('a row dropped on a zone is the setPosterEntries payload', () => {
    expect(planDrop({ kind: 'asso', id: 'a' }, 'z2', zoneIds, zoneOf)).toEqual({
      kind: 'assign',
      rows: [{ associationId: 'a', zoneId: 'z2' }],
    });
  });
  it('a row dropped on the no-zone group clears its zone', () => {
    expect(planDrop({ kind: 'asso', id: 'b' }, null, zoneIds, zoneOf)).toEqual({
      kind: 'assign',
      rows: [{ associationId: 'b', zoneId: null }],
    });
  });
  it('a zone dropped on a zone is the new order', () => {
    expect(planDrop({ kind: 'zone', id: 'z1' }, 'z2', zoneIds, zoneOf)).toEqual({
      kind: 'reorder',
      order: ['z2', 'z1'],
    });
  });
  it('changes nothing: same zone, zone on the no-zone group, foreign drag', () => {
    expect(planDrop({ kind: 'asso', id: 'b' }, 'z1', zoneIds, zoneOf)).toBeNull();
    expect(planDrop({ kind: 'zone', id: 'z1' }, null, zoneIds, zoneOf)).toBeNull();
    expect(planDrop(null, 'z1', zoneIds, zoneOf)).toBeNull();
  });
});
