import { describe, expect, it } from 'vitest';
import {
  assoEmailFontSize,
  findUnitOverlaps,
  memberCardHeight,
  memberCardMetrics,
  MIN_POSTER_TEXT_PX,
  PT_PER_POSTER_PX,
  unitInkBox,
  type PositionedBubble,
  type UnitBox,
} from './layout';
import type { PosterMemberRef } from './generator';

function member(over: Partial<PosterMemberRef> = {}): PosterMemberRef {
  return {
    userId: 'u1',
    name: 'Jeanne BOUSSONNIERE',
    firstName: 'Jeanne',
    lastName: 'BOUSSONNIERE',
    role: 'Tresoriere',
    isAdmin: true,
    ...over,
  };
}

function bubble(over: Partial<PositionedBubble> = {}): PositionedBubble {
  return {
    assoId: 'a1',
    x: 0,
    y: 0,
    scale: 1,
    z: 1,
    colorOverride: null,
    showPresident: true,
    shape: 'blob-1',
    logoShape: 'square',
    ...over,
  };
}

describe('assoEmailFontSize - the address is readable on the sheet, not in the unit', () => {
  // Measured on the published map: at 0.35 x the name inside a unit scaled to 0.46, the contact
  // address printed at ~3 pt on A0.
  it('holds the poster floor however small the unit is', () => {
    for (const scale of [1, 0.6, 0.46, 0.2]) {
      const printed = assoEmailFontSize('Bureau des Eleves', scale) * scale * PT_PER_POSTER_PX;
      expect(printed).toBeGreaterThanOrEqual(MIN_POSTER_TEXT_PX * PT_PER_POSTER_PX - 0.01);
    }
  });

  it('leaves a full-size unit on its proportional size', () => {
    expect(assoEmailFontSize('Bureau des Eleves', 1)).toBeGreaterThan(MIN_POSTER_TEXT_PX);
  });

  it('grows as the unit shrinks', () => {
    expect(assoEmailFontSize('BDE', 0.3)).toBeGreaterThan(assoEmailFontSize('BDE', 0.6));
  });
});

describe('memberCardHeight - an estimate of the card the DOM draws', () => {
  it('counts a wrapped name as more than one line', () => {
    const short = member({ name: 'Leo BAR', role: '' });
    const long = member({ name: 'Elliot WAGHEMACKER DE LA TOUR', role: '' });
    const hShort = memberCardHeight(short, memberCardMetrics(short.name, 'bureau'));
    const hLong = memberCardHeight(long, memberCardMetrics(long.name, 'bureau'));
    expect(hLong).toBeGreaterThan(hShort);
  });

  it('adds nothing for a member with no role', () => {
    const card = memberCardMetrics('Leo BAR', 'bureau');
    const withRole = memberCardHeight({ name: 'Leo BAR', role: 'President' }, card);
    const without = memberCardHeight({ name: 'Leo BAR', role: '' }, card);
    expect(withRole).toBeGreaterThan(without);
  });

  it('is taller than the photo it contains', () => {
    const card = memberCardMetrics('Leo BAR', 'president');
    expect(memberCardHeight({ name: 'Leo BAR', role: 'President' }, card)).toBeGreaterThan(
      card.photo
    );
  });
});

describe('unitInkBox - what a unit covers, not the cell it was seeded in', () => {
  const roster = [
    member({ userId: 'p', name: 'Alice MARTIN', role: 'Presidente' }),
    member({ userId: 'b1', name: 'Tristan FELIX', role: 'Secretaire' }),
  ];

  it('reaches past the blob, because the cards do', () => {
    const box = unitInkBox(bubble(), roster);
    // The blob alone is 210 px wide and 210 tall, centered on the unit.
    expect(box.w).toBeGreaterThan(210);
    expect(box.h).toBeGreaterThan(210);
  });

  it('is smaller than the seed cell it lives in', () => {
    const box = unitInkBox(bubble(), roster);
    expect(box.w).toBeLessThan(400);
    expect(box.h).toBeLessThan(430);
  });

  it('scales with the unit and translates with it', () => {
    const full = unitInkBox(bubble(), roster);
    const half = unitInkBox(bubble({ scale: 0.5, x: 100, y: 40 }), roster);
    expect(half.w).toBeCloseTo(full.w / 2, 1);
    expect(half.h).toBeCloseTo(full.h / 2, 1);
    expect(half.x).toBeCloseTo(100 + full.x / 2, 1);
    expect(half.y).toBeCloseTo(40 + full.y / 2, 1);
  });

  it('ignores members the author did not put in a slot', () => {
    const crowded = [...roster, member({ userId: 'x', name: 'Zoe ZZZ', role: 'Membre' })];
    const chosen = bubble({ selectedBureau: ['p', 'b1'] });
    expect(unitInkBox(chosen, crowded)).toEqual(unitInkBox(chosen, roster));
  });
});

describe('findUnitOverlaps - reported, worst first, and never repaired', () => {
  const box = (x: number, y: number, w = 100, h = 100): UnitBox => ({ x, y, w, h });

  it('finds nothing between units set side by side', () => {
    expect(
      findUnitOverlaps([
        { assoId: 'a', box: box(0, 0) },
        { assoId: 'b', box: box(200, 0) },
      ])
    ).toEqual([]);
  });

  it('does not call touching edges a crossing', () => {
    expect(
      findUnitOverlaps([
        { assoId: 'a', box: box(0, 0) },
        { assoId: 'b', box: box(100, 0) },
      ])
    ).toEqual([]);
  });

  it('measures the crossing and names both units', () => {
    expect(
      findUnitOverlaps([
        { assoId: 'a', box: box(0, 0) },
        { assoId: 'b', box: box(90, 80) },
      ])
    ).toEqual([{ a: 'a', b: 'b', area: 200 }]);
  });

  it('puts the worst crossing first', () => {
    const found = findUnitOverlaps([
      { assoId: 'a', box: box(0, 0) },
      { assoId: 'b', box: box(90, 80) },
      { assoId: 'c', box: box(10, 10) },
    ]);
    const areas = found.map((o) => o.area);
    expect(areas).toEqual(areas.toSorted((x, y) => y - x));
    expect(found[0]).toMatchObject({ a: 'a', b: 'c' });
  });

  it('reports a pair once, not twice', () => {
    const found = findUnitOverlaps([
      { assoId: 'a', box: box(0, 0) },
      { assoId: 'b', box: box(10, 10) },
    ]);
    expect(found).toHaveLength(1);
  });
});
