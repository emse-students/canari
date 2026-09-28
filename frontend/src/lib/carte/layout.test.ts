import { describe, expect, it } from 'vitest';
import {
  assoEmailFontSize,
  findUnitOverlaps,
  fitUnitNameSize,
  placeUnitCards,
  type ShownMembers,
  memberCardHeight,
  memberCardMetrics,
  MIN_POSTER_TEXT_PX,
  PT_PER_POSTER_PX,
  unitInkBox,
  unitInkShapes,
  type InkShape,
  type PositionedBubble,
} from './layout';
import { borderRadiusCorners, type CornerRadii } from './shapes';
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

describe('fitUnitNameSize - one size per unit, grown until the crown stops it', () => {
  const crowd = (n: number): ShownMembers => ({
    president: member({ userId: 'p', name: 'Alice MARTIN', role: 'Presidente' }),
    bureau: Array.from({ length: n }, (_, i) =>
      member({ userId: `b${i}`, name: 'Tristan FELIX', role: 'Secretaire' })
    ),
  });

  it('grows the text as the unit shrinks, since the floor is a size on the SHEET', () => {
    const small = fitUnitNameSize(crowd(2), 0.3);
    const large = fitUnitNameSize(crowd(2), 1);
    expect(small).toBeGreaterThan(large);
  });

  // D12: the crown does NOT grow with the text, so a full crown stops the growth earlier than a
  // sparse one - which is exactly the shortfall the user accepted.
  it('stops earlier on a crowded crown than on an empty one', () => {
    expect(fitUnitNameSize(crowd(6), 0.3)).toBeLessThanOrEqual(fitUnitNameSize(crowd(1), 0.3));
  });

  it('never returns a size at which the unit draws two cards over each other', () => {
    for (const scale of [1, 0.6, 0.46, 0.2]) {
      const shown = crowd(6);
      const placed = placeUnitCards(shown, fitUnitNameSize(shown, scale));
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i];
          const b = placed[j];
          const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          expect(w <= 0 || h <= 0).toBe(true);
        }
      }
    }
  });

  it('gives every card of a unit the same name size', () => {
    const shown: ShownMembers = {
      president: member({ userId: 'p', name: 'Alice MARTIN', role: 'Presidente' }),
      bureau: [
        member({ userId: 'b1', name: 'Zoe ZZ', role: 'Tresoriere' }),
        member({ userId: 'b2', name: 'Thomas DELLESTABLE', role: 'Secretaire' }),
      ],
    };
    const sizes = placeUnitCards(shown, fitUnitNameSize(shown, 0.46)).map((p) => p.card.nameSize);
    expect(new Set(sizes).size).toBe(1);
  });

  it('answers the same thing twice for the same unit', () => {
    expect(fitUnitNameSize(crowd(4), 0.46)).toBe(fitUnitNameSize(crowd(4), 0.46));
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

  // It does NOT simply scale, and that is the point of D12: a smaller unit grows its card text
  // toward the readable floor, so its box covers more than half of a full-size one's.
  it('translates with the unit, and covers more than half when the unit is halved', () => {
    const full = unitInkBox(bubble(), roster);
    const half = unitInkBox(bubble({ scale: 0.5, x: 100, y: 40 }), roster);
    expect(half.x).toBeCloseTo(100 + full.x / 2, 1);
    expect(half.y).toBeCloseTo(40 + full.y / 2, 1);
    expect(half.h).toBeGreaterThanOrEqual(full.h / 2);
    expect(half.h).toBeLessThan(full.h);
  });

  it('ignores members the author did not put in a slot', () => {
    const crowded = [...roster, member({ userId: 'x', name: 'Zoe ZZZ', role: 'Membre' })];
    const chosen = bubble({ selectedBureau: ['p', 'b1'] });
    expect(unitInkBox(chosen, crowded)).toEqual(unitInkBox(chosen, roster));
  });
});

describe('findUnitOverlaps - reported, worst first, and never repaired', () => {
  const square: CornerRadii = [
    { rx: 0, ry: 0 },
    { rx: 0, ry: 0 },
    { rx: 0, ry: 0 },
    { rx: 0, ry: 0 },
  ];
  const box = (x: number, y: number, w = 100, h = 100): InkShape[] => [
    { x, y, w, h, corners: square },
  ];
  const disc = (x: number, y: number, d = 100): InkShape[] => [
    { x, y, w: d, h: d, corners: borderRadiusCorners('50%', d, d) },
  ];

  it('finds nothing between units set side by side', () => {
    expect(
      findUnitOverlaps([
        { assoId: 'a', shapes: box(0, 0) },
        { assoId: 'b', shapes: box(200, 0) },
      ])
    ).toEqual([]);
  });

  it('does not call touching edges a crossing', () => {
    expect(
      findUnitOverlaps([
        { assoId: 'a', shapes: box(0, 0) },
        { assoId: 'b', shapes: box(100, 0) },
      ])
    ).toEqual([]);
  });

  it('measures the crossing and names both units', () => {
    expect(
      findUnitOverlaps([
        { assoId: 'a', shapes: box(0, 0) },
        { assoId: 'b', shapes: box(90, 80) },
      ])
    ).toEqual([{ a: 'a', b: 'b', area: 200 }]);
  });

  // THE CASE THE USER SAW (2026-09-28): two round blobs set corner to corner. Their boxes cross by
  // 20 x 20, their ink not at all - the gap between two circles at 45 degrees is widest exactly there.
  it('does not report two round blobs whose boxes cross only at the corners', () => {
    expect(
      findUnitOverlaps([
        { assoId: 'a', shapes: disc(0, 0) },
        { assoId: 'b', shapes: disc(80, 80) },
      ])
    ).toEqual([]);
  });

  it('still reports two round blobs that really cross', () => {
    const found = findUnitOverlaps([
      { assoId: 'a', shapes: disc(0, 0) },
      { assoId: 'b', shapes: disc(60, 0) },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].area).toBeGreaterThan(0);
  });

  it('counts a crossing with ANY shape of a unit, not just its first', () => {
    const found = findUnitOverlaps([
      { assoId: 'a', shapes: [...box(0, 0, 10, 10), ...box(300, 0)] },
      { assoId: 'b', shapes: box(350, 50) },
    ]);
    expect(found).toEqual([{ a: 'a', b: 'b', area: 2500 }]);
  });

  it('puts the worst crossing first', () => {
    const found = findUnitOverlaps([
      { assoId: 'a', shapes: box(0, 0) },
      { assoId: 'b', shapes: box(90, 80) },
      { assoId: 'c', shapes: box(10, 10) },
    ]);
    const areas = found.map((o) => o.area);
    expect(areas).toEqual(areas.toSorted((x, y) => y - x));
    expect(found[0]).toMatchObject({ a: 'a', b: 'c' });
  });

  it('reports a pair once, not twice', () => {
    const found = findUnitOverlaps([
      { assoId: 'a', shapes: box(0, 0) },
      { assoId: 'b', shapes: box(10, 10) },
    ]);
    expect(found).toHaveLength(1);
  });
});

describe('unitInkShapes - the blob and every card, where the canvas draws them', () => {
  const roster = [
    member({ userId: 'p', name: 'Alice MARTIN', role: 'Presidente' }),
    member({ userId: 'b1', name: 'Tristan FELIX', role: 'Secretaire' }),
  ];

  it('is the blob plus one shape per card drawn', () => {
    expect(unitInkShapes(bubble(), roster)).toHaveLength(3);
  });

  it('bounds to exactly the box the editor outlines', () => {
    const shapes = unitInkShapes(bubble({ x: 40, y: 20, scale: 0.7 }), roster);
    const box = unitInkBox(bubble({ x: 40, y: 20, scale: 0.7 }), roster);
    expect(Math.min(...shapes.map((sh) => sh.x))).toBeCloseTo(box.x, 1);
    expect(Math.max(...shapes.map((sh) => sh.x + sh.w))).toBeCloseTo(box.x + box.w, 1);
  });
});

describe('borderRadiusCorners - the silhouette CSS draws', () => {
  it('reads one value as four equal corners', () => {
    expect(borderRadiusCorners('50%', 200, 100)).toEqual([
      { rx: 100, ry: 50 },
      { rx: 100, ry: 50 },
      { rx: 100, ry: 50 },
      { rx: 100, ry: 50 },
    ]);
  });

  it('reads the horizontal / vertical halves in corner order', () => {
    const [tl, tr, br, bl] = borderRadiusCorners('40% 60% 70% 30% / 40% 40% 60% 60%', 100, 100);
    expect([tl, tr, br, bl]).toEqual([
      { rx: 40, ry: 40 },
      { rx: 60, ry: 40 },
      { rx: 70, ry: 60 },
      { rx: 30, ry: 60 },
    ]);
  });

  it('shrinks every corner alike when one side is over-full, as the spec does', () => {
    const corners = borderRadiusCorners('80%', 100, 100);
    expect(corners[0]).toEqual({ rx: 50, ry: 50 });
  });

  it('refuses a unit it cannot resolve rather than guessing an outline', () => {
    expect(() => borderRadiusCorners('12px', 100, 100)).toThrow();
  });
});
