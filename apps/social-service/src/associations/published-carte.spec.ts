import { sanitizePublishedCarte, PUBLISHED_CARTE_VERSION } from './published-carte';

/** A minimal, valid v2 publication payload; individual tests override the field under test. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    aspectRatio: Math.SQRT2,
    stage: { w: 1600, h: 1131 },
    background: { dataUrl: null, scrimOpacity: 20 },
    style: {
      pageBg: '#fdf3e3',
      scrimColor: '#3a2a12',
      cardBg: '#ffffff',
      cardTextColor: '#374151',
      directoryBg: 'rgba(255,255,255,0.86)',
      directoryTextColor: '#1f2937',
      directoryMutedColor: '#6b7280',
    },
    title: {
      x: 48,
      y: 36,
      w: 1004,
      z: 0,
      size: 52,
      weight: 700,
      content: 'Carte 2026',
      align: 'left',
      color: '#7c2d12',
    },
    units: [unit()],
    texts: [],
    directory: null,
    ...overrides,
  };
}

/** A minimal, valid unit; tests override or drop the part under test. */
function unit(overrides: Record<string, unknown> = {}) {
  return {
    assoId: 'a1',
    x: 120,
    y: 200,
    w: 400,
    h: 430,
    scale: 0.6,
    z: 3,
    color: '#e09f3e',
    colorFallback: 'hsl(210, 70%, 50%)',
    blob: { x: 95, y: 67, size: 210, radius: '50%' },
    logo: { x: 154, y: 88, w: 92, h: 92, radius: '26%', initialsSize: 36, initials: 'BD' },
    name: { x: 123, y: 184, w: 154, size: 15, emailSize: 5.25 },
    cards: [
      {
        userId: 'u1',
        name: 'Claire Vanruymbeke',
        role: 'Presidente',
        initials: 'CV',
        x: 163,
        y: 246,
        w: 73,
        photo: 61,
        nameSize: 8.9,
        roleSize: 7.5,
      },
    ],
    ...overrides,
  };
}

describe('sanitizePublishedCarte', () => {
  it('keeps a well-formed document and stamps the schema version', () => {
    const out = sanitizePublishedCarte(payload());
    expect(out).not.toBeNull();
    expect(out?.version).toBe(PUBLISHED_CARTE_VERSION);
    expect(out?.stage).toEqual({ w: 1600, h: 1131 });
    expect(out?.units).toHaveLength(1);
    expect(out?.units[0]).toMatchObject({
      assoId: 'a1',
      x: 120,
      y: 200,
      scale: 0.6,
      color: '#e09f3e',
      colorFallback: 'hsl(210, 70%, 50%)',
    });
    expect(out?.units[0].blob).toEqual({ x: 95, y: 67, size: 210, radius: '50%' });
    expect(out?.units[0].cards[0]).toMatchObject({
      userId: 'u1',
      initials: 'CV',
      w: 73,
      photo: 61,
      nameSize: 8.9,
    });
    expect(out?.title).toMatchObject({ content: 'Carte 2026', size: 52, weight: 700 });
  });

  it('refuses a document with no placeable association rather than publishing a blank frame', () => {
    expect(sanitizePublishedCarte(payload({ units: [] }))).toBeNull();
    expect(sanitizePublishedCarte(payload({ units: 'nope' }))).toBeNull();
    expect(sanitizePublishedCarte(null)).toBeNull();
    expect(sanitizePublishedCarte('a string')).toBeNull();
  });

  // A v1 document carries `bubbles`, not `units`. It cannot be upgraded here (its members and
  // resolved geometry only exist in the editor), so it is refused rather than half-read.
  it('refuses a v1 payload instead of publishing half of it', () => {
    expect(
      sanitizePublishedCarte({
        aspectRatio: Math.SQRT2,
        bubbles: [{ assoId: 'a1', x: 0.1, y: 0.2, w: 0.15, z: 1, radius: '50%' }],
        texts: [],
      })
    ).toBeNull();
  });

  it('drops a unit with no usable association id', () => {
    const out = sanitizePublishedCarte(
      payload({
        units: [{ x: 10 }, { assoId: '' }, { assoId: 'a'.repeat(65) }, unit({ assoId: 'ok' })],
      })
    );
    expect(out?.units.map((u) => u.assoId)).toEqual(['ok']);
  });

  it('drops a member card with no user id, keeping the rest of the crown', () => {
    const out = sanitizePublishedCarte(
      payload({
        units: [unit({ cards: [{ name: 'Ghost' }, { userId: 'u2', name: 'Real' }] })],
      })
    );
    expect(out?.units[0].cards.map((c) => c.userId)).toEqual(['u2']);
  });

  // A radius lands in a `style` attribute on the consumer, so anything that is not a radius is
  // rejected outright rather than escaped.
  it('rejects a border-radius carrying anything but radius syntax', () => {
    const out = sanitizePublishedCarte(
      payload({
        units: [
          unit({
            blob: { radius: 'red;background:url(https://evil.example/x)' },
            logo: { radius: 'expression(alert(1))' },
          }),
        ],
      })
    );
    expect(out?.units[0].blob.radius).toBe('50%');
    expect(out?.units[0].logo.radius).toBe('50%');
  });

  it('accepts the multi-value radius shorthand the shape catalog produces', () => {
    const shorthand = '63% 37% 54% 46% / 55% 48% 52% 45%';
    const out = sanitizePublishedCarte(payload({ units: [unit({ blob: { radius: shorthand } })] }));
    expect(out?.units[0].blob.radius).toBe(shorthand);
  });

  it('nulls an author-picked color that is not a hex literal', () => {
    const out = sanitizePublishedCarte(
      payload({
        title: { content: 'T', color: 'javascript:alert(1)' },
        units: [unit({ color: 'rgb(1,2,3)' })],
      })
    );
    expect(out?.title?.color).toBe('#ffffff');
    expect(out?.units[0].color).toBeNull();
  });

  // The poster's own palette is not all hex (rgba panel, hsl fallback color), so those two
  // functional forms are accepted - but as a closed grammar, like the radius.
  it('accepts rgb/hsl in the resolved palette and rejects anything else', () => {
    const out = sanitizePublishedCarte(
      payload({
        style: {
          directoryBg: 'rgba(255,255,255,0.86)',
          pageBg: 'url(https://evil.example/x)',
          cardTextColor: '#374151',
        },
        units: [unit({ colorFallback: 'hsl(12, 65%, 47%)' })],
      })
    );
    expect(out?.style.directoryBg).toBe('rgba(255,255,255,0.86)');
    expect(out?.style.pageBg).toBe('#fdf3e3');
    expect(out?.units[0].colorFallback).toBe('hsl(12, 65%, 47%)');
    expect(
      sanitizePublishedCarte(payload({ units: [unit({ colorFallback: 'red;x:1' })] }))?.units[0]
        .colorFallback
    ).toBe('#888888');
  });

  it('clamps out-of-range geometry instead of trusting it', () => {
    const out = sanitizePublishedCarte(
      payload({
        aspectRatio: 9999,
        units: [unit({ x: -99_999, y: 99_999, scale: 500, z: -3 })],
      })
    );
    expect(out?.aspectRatio).toBe(5);
    expect(out?.units[0]).toMatchObject({ x: -20_000, y: 20_000, scale: 10, z: 0 });
  });

  // NaN and Infinity are not clamped: a non-finite number is not "too big", it is not a number,
  // so it falls back like a string would. JSON.parse yields neither, but a hand-built body can.
  it('substitutes defaults for non-numeric geometry', () => {
    const out = sanitizePublishedCarte(
      payload({ units: [unit({ x: 'left', y: null, scale: NaN, z: Infinity })] })
    );
    expect(out?.units[0]).toMatchObject({ x: 0, y: 0, scale: 1, z: 1 });
  });

  it('caps a member name and a directory line instead of serving unbounded strings', () => {
    const out = sanitizePublishedCarte(
      payload({
        units: [unit({ cards: [{ userId: 'u1', name: 'x'.repeat(500) }] })],
        directory: {
          zones: [{ label: 'z', assos: [{ assoId: 'a1', line: 'y'.repeat(9000) }] }],
        },
      })
    );
    expect(out?.units[0].cards[0].name).toHaveLength(200);
    expect(out?.directory?.zones[0].assos[0].line).toHaveLength(4000);
  });

  it('only accepts an image data URL as the background', () => {
    expect(
      sanitizePublishedCarte(payload({ background: { dataUrl: 'https://evil.example/x.png' } }))
        ?.background.dataUrl
    ).toBeNull();
    expect(
      sanitizePublishedCarte(payload({ background: { dataUrl: 'data:text/html,<script>' } }))
        ?.background.dataUrl
    ).toBeNull();
    expect(
      sanitizePublishedCarte(payload({ background: { dataUrl: 'data:image/png;base64,AAAA' } }))
        ?.background.dataUrl
    ).toBe('data:image/png;base64,AAAA');
  });

  it('drops an oversized background rather than serving it publicly', () => {
    const huge = `data:image/png;base64,${'A'.repeat(6_000_001)}`;
    expect(
      sanitizePublishedCarte(payload({ background: { dataUrl: huge } }))?.background.dataUrl
    ).toBeNull();
  });

  it('rounds the scrim and clamps it to a percentage', () => {
    expect(
      sanitizePublishedCarte(payload({ background: { scrimOpacity: 143.6 } }))?.background
        .scrimOpacity
    ).toBe(100);
    expect(
      sanitizePublishedCarte(payload({ background: { scrimOpacity: 18.4 } }))?.background
        .scrimOpacity
    ).toBe(18);
  });

  it('keeps free text, drops empty labels and whitelists the alignment', () => {
    const out = sanitizePublishedCarte(
      payload({
        texts: [
          { content: '   ', x: 10 },
          { content: 'La Vie Asso', x: 300, y: 50, w: 400, size: 40, align: 'justify' },
          { content: 'Bienvenue', align: 'right', weight: 500 },
        ],
      })
    );
    expect(out?.texts).toHaveLength(2);
    expect(out?.texts[0]).toMatchObject({ content: 'La Vie Asso', align: 'center', size: 40 });
    expect(out?.texts[1]).toMatchObject({ content: 'Bienvenue', align: 'right', weight: 500 });
  });

  it('truncates a text label instead of serving an unbounded string', () => {
    const out = sanitizePublishedCarte(payload({ texts: [{ content: 'x'.repeat(2000) }] }));
    expect(out?.texts[0].content).toHaveLength(1000);
  });

  it('caps how many elements a single publication can carry', () => {
    const many = Array.from({ length: 500 }, (_, i) => unit({ assoId: `a${i}` }));
    const manyTexts = Array.from({ length: 300 }, () => ({ content: 'x' }));
    const manyCards = Array.from({ length: 30 }, (_, i) => ({ userId: `u${i}` }));
    const out = sanitizePublishedCarte(
      payload({ units: [unit({ cards: manyCards }), ...many], texts: manyTexts })
    );
    expect(out?.units).toHaveLength(400);
    expect(out?.units[0].cards).toHaveLength(12);
    expect(out?.texts).toHaveLength(200);
  });

  it('ignores unknown keys instead of echoing them to anonymous visitors', () => {
    const out = sanitizePublishedCarte(
      payload({
        createdBy: 'admin@example.org',
        secret: 'x',
        units: [unit({ pii: 'x' })],
      })
    );
    expect(Object.keys(out ?? {}).sort()).toEqual([
      'aspectRatio',
      'background',
      'directory',
      'stage',
      'style',
      'texts',
      'title',
      'units',
      'version',
    ]);
    expect(out?.units[0]).not.toHaveProperty('pii');
  });
});
