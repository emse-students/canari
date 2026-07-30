import { buildPublishedCarte } from './publish';
import { CARTE_STYLE } from './theme';
import {
  UNIT_CX,
  BLOB_CY,
  BLOB_SIZE,
  NAME_TOP,
  NAME_INSET,
  PRES_TOP,
  MAX_BUREAU,
  STAGE_WIDTH,
  type PositionedBubble,
  type Decoration,
} from './layout';
import type { PosterBubble, PosterMemberRef, PosterModel } from './generator';

function member(id: string, name: string, role = '', isAdmin = true): PosterMemberRef {
  return { userId: id, name, role, isAdmin };
}

function content(overrides: Partial<PosterBubble> = {}): PosterBubble {
  const members = overrides.members ?? [
    member('u-pres', 'Alice Martin', 'Presidente'),
    member('u-b1', 'Bob Durand', 'Tresorier'),
    member('u-b2', 'Chloe Petit', 'Secretaire'),
  ];
  return {
    assoId: 'a1',
    name: 'Club Test',
    color: '#e09f3e',
    logoUrl: null,
    president: members[0] ?? null,
    bureau: members.slice(1),
    members,
    contactEmail: 'club@example.org',
    memberCount: members.length,
    ...overrides,
  };
}

function bubble(overrides: Partial<PositionedBubble> = {}): PositionedBubble {
  return {
    assoId: 'a1',
    x: 120,
    y: 240,
    scale: 0.6,
    z: 3,
    colorOverride: null,
    showPresident: true,
    shape: 'circle',
    logoShape: 'circle',
    ...overrides,
  };
}

function model(bubbles: PosterBubble[]): PosterModel {
  return {
    zones: [{ categoryId: 'c1', label: 'Culture, Arts', bubbles }],
    totalAssos: bubbles.length,
  };
}

/** Builds a publication from one association, with everything else at its default. */
function build(
  options: {
    bubbles?: PositionedBubble[];
    content?: Record<string, PosterBubble>;
    model?: PosterModel;
    decorations?: Decoration[];
    title?: string;
    directoryVisible?: boolean;
  } = {}
) {
  const data = options.content ?? { a1: content() };
  return buildPublishedCarte({
    bubbles: options.bubbles ?? [bubble()],
    content: data,
    model: options.model ?? model(Object.values(data)),
    decorations: options.decorations ?? [],
    background: { dataUrl: null, scrimOpacity: 18 },
    style: CARTE_STYLE,
    title: options.title ?? 'Carte 2026',
    directoryVisible: options.directoryVisible ?? true,
    directoryHeading: 'Annuaire des membres',
  });
}

describe('buildPublishedCarte', () => {
  // The showcase draws these boxes verbatim, so they are the whole fidelity contract: if the poster
  // moves a layer and this test still passes, the published map has silently drifted from the print.
  it('resolves the unit layers to the poster geometry, in poster pixels', () => {
    const out = build();
    const unit = out.units[0];

    expect(out.stage).toEqual({ w: STAGE_WIDTH, h: Math.round(STAGE_WIDTH / Math.SQRT2) });
    // Placement stays in poster px (v1 published fractions of the frame).
    expect(unit).toMatchObject({ assoId: 'a1', x: 120, y: 240, scale: 0.6, z: 3 });
    expect(unit.blob).toEqual({
      x: UNIT_CX - BLOB_SIZE / 2,
      y: BLOB_CY - BLOB_SIZE / 2,
      size: BLOB_SIZE,
      radius: '50%',
    });
    // The logo is centered on the blob's upper part and may overflow it.
    expect(unit.logo.x + unit.logo.w / 2).toBe(UNIT_CX);
    expect(unit.logo.radius).toBe('50%');
    expect(unit.logo.initials).toBe('CT');
    expect(unit.name).toMatchObject({ y: NAME_TOP, w: BLOB_SIZE - NAME_INSET });
    expect(unit.name.x + unit.name.w / 2).toBe(UNIT_CX);
  });

  it('publishes the bureau crown first and the president last, centered at the blob bottom', () => {
    const out = build();
    const cards = out.units[0].cards;

    expect(cards.map((c) => c.userId)).toEqual(['u-b1', 'u-b2', 'u-pres']);
    const president = cards[cards.length - 1];
    expect(president.x + president.w / 2).toBe(UNIT_CX);
    expect(president.y).toBe(PRES_TOP);
    // The crown sits above the president card, fanned around the unit's center line.
    expect(cards[0].y).toBeLessThan(president.y);
    expect(cards[0].x).not.toBe(cards[1].x);
    expect(cards.every((c) => c.initials.length === 2)).toBe(true);
  });

  it('caps the crown at the poster limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => member(`u${i}`, `Member ${i}`));
    const out = build({ content: { a1: content({ members: many }) } });
    expect(out.units[0].cards).toHaveLength(MAX_BUREAU + 1);
  });

  it("honours the author's explicit bureau selection over the admin flag", () => {
    const members = [
      member('u1', 'Alice', 'Presidente', true),
      member('u2', 'Bob', '', false),
      member('u3', 'Chloe', '', true),
    ];
    const out = build({
      bubbles: [bubble({ selectedBureau: ['u2', 'u3'] })],
      content: { a1: content({ members }) },
    });
    // First selected member takes the president slot, the rest form the crown.
    expect(out.units[0].cards.map((c) => c.userId)).toEqual(['u3', 'u2']);
  });

  it('shrinks a name to fit its card, then widens the card when shrinking is not enough', () => {
    // One member each, so `cards[0]` is the president card under test.
    const card = (name: string) =>
      build({ content: { a1: content({ members: [member('u-pres', name, 'President')] }) } })
        .units[0].cards[0];
    const short = card('Bob Petit');
    const long = card('Elliot WAGHEMACKER');
    const unbreakable = card('Jean SCHWARTZENBERGERMANN');

    // A name that still wraps into the base card only costs font size...
    expect(long.w).toBe(short.w);
    expect(long.nameSize).toBeLessThan(short.nameSize);
    // ...while a word too wide even at the floor size widens the card instead of breaking mid-word.
    expect(unbreakable.w).toBeGreaterThan(short.w);
    // The photo never follows the card's width: one member's face must not dwarf its neighbours'.
    expect(unbreakable.photo).toBe(short.photo);
    // Whatever its width, a card stays centered on its slot.
    expect(unbreakable.x + unbreakable.w / 2).toBe(UNIT_CX);
    // And the role line never outgrows the name it labels.
    expect(unbreakable.roleSize).toBeLessThanOrEqual(unbreakable.nameSize);
  });

  it('drops a bubble whose association no longer resolves', () => {
    const out = build({ bubbles: [bubble(), bubble({ assoId: 'gone' })] });
    expect(out.units.map((u) => u.assoId)).toEqual(['a1']);
  });

  it('publishes free text in poster pixels with a resolved font weight', () => {
    const deco: Decoration = {
      id: 'd1',
      kind: 'text',
      x: 300,
      y: 80,
      scale: 2,
      z: 5,
      content: 'La Vie Asso',
      color: '#ffffff',
      bold: true,
      align: 'center',
    };
    const out = build({ decorations: [deco, { ...deco, id: 'd2', content: '  ', bold: false }] });
    expect(out.texts).toHaveLength(1);
    expect(out.texts[0]).toMatchObject({ x: 300, y: 80, w: 640, size: 68, weight: 800 });
    expect(build({ decorations: [{ ...deco, bold: false }] }).texts[0].weight).toBe(500);
  });

  it('prints the directory roster alphabetically, with roles in parentheses', () => {
    const members = [member('u1', 'Zoe Bernard', 'Presidente'), member('u2', 'Alice Martin', '')];
    const out = build({ content: { a1: content({ members }) } });
    expect(out.directory?.zones[0]).toEqual({
      label: 'Culture, Arts',
      assos: [{ assoId: 'a1', line: 'Alice Martin - Zoe Bernard (Presidente)' }],
    });
    expect(out.directory?.heading).toBe('Annuaire des membres');
  });

  it('omits the directory the author hid, and widens the title band in its place', () => {
    const withDir = build();
    const withoutDir = build({ directoryVisible: false });
    expect(withoutDir.directory).toBeNull();
    expect(withoutDir.title?.w).toBeGreaterThan(withDir.title?.w ?? 0);
  });

  it('omits a title the project does not have', () => {
    expect(build({ title: '   ' }).title).toBeNull();
  });

  it('keeps the association color live: only an override travels', () => {
    expect(build().units[0]).toMatchObject({ color: null, colorFallback: '#e09f3e' });
    expect(build({ bubbles: [bubble({ colorOverride: '#123456' })] }).units[0].color).toBe(
      '#123456'
    );
  });
});
