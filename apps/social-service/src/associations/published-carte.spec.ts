import { sanitizePublishedCarte, PUBLISHED_CARTE_VERSION } from './published-carte';

/** A minimal, valid publication payload; individual tests override the field under test. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    aspectRatio: Math.SQRT2,
    background: { dataUrl: null, scrimOpacity: 20 },
    titleColor: '#7c2d12',
    bubbles: [
      {
        assoId: 'a1',
        x: 0.1,
        y: 0.2,
        w: 0.15,
        z: 3,
        color: '#e09f3e',
        radius: '50%',
        logoRadius: '26%',
      },
    ],
    texts: [],
    ...overrides,
  };
}

describe('sanitizePublishedCarte', () => {
  it('keeps a well-formed document and stamps the schema version', () => {
    const out = sanitizePublishedCarte(payload());
    expect(out).not.toBeNull();
    expect(out?.version).toBe(PUBLISHED_CARTE_VERSION);
    expect(out?.bubbles).toHaveLength(1);
    expect(out?.bubbles[0]).toEqual({
      assoId: 'a1',
      x: 0.1,
      y: 0.2,
      w: 0.15,
      z: 3,
      color: '#e09f3e',
      radius: '50%',
      logoRadius: '26%',
    });
  });

  it('refuses a document with no placeable association rather than publishing a blank frame', () => {
    expect(sanitizePublishedCarte(payload({ bubbles: [] }))).toBeNull();
    expect(sanitizePublishedCarte(payload({ bubbles: 'nope' }))).toBeNull();
    expect(sanitizePublishedCarte(null)).toBeNull();
    expect(sanitizePublishedCarte('a string')).toBeNull();
  });

  it('drops a bubble with no usable association id', () => {
    const out = sanitizePublishedCarte(
      payload({
        bubbles: [{ x: 0.1 }, { assoId: '' }, { assoId: 'a'.repeat(65) }, { assoId: 'ok' }],
      })
    );
    expect(out?.bubbles.map((b) => b.assoId)).toEqual(['ok']);
  });

  // A radius lands in a `style` attribute on the consumer, so anything that is not a radius is
  // rejected outright rather than escaped.
  it('rejects a border-radius carrying anything but radius syntax', () => {
    const out = sanitizePublishedCarte(
      payload({
        bubbles: [
          {
            assoId: 'a1',
            radius: 'red;background:url(https://evil.example/x)',
            logoRadius: 'expression(alert(1))',
          },
        ],
      })
    );
    expect(out?.bubbles[0].radius).toBe('50%');
    expect(out?.bubbles[0].logoRadius).toBe('50%');
  });

  it('accepts the multi-value radius shorthand the shape catalog produces', () => {
    const shorthand = '63% 37% 54% 46% / 55% 48% 52% 45%';
    const out = sanitizePublishedCarte(payload({ bubbles: [{ assoId: 'a1', radius: shorthand }] }));
    expect(out?.bubbles[0].radius).toBe(shorthand);
  });

  it('nulls a color that is not a hex literal', () => {
    const out = sanitizePublishedCarte(
      payload({
        titleColor: 'javascript:alert(1)',
        bubbles: [{ assoId: 'a1', color: 'rgb(1,2,3)' }],
      })
    );
    expect(out?.titleColor).toBeNull();
    expect(out?.bubbles[0].color).toBeNull();
  });

  it('clamps out-of-range geometry instead of trusting it', () => {
    const out = sanitizePublishedCarte(
      payload({
        aspectRatio: 9999,
        bubbles: [{ assoId: 'a1', x: -50, y: 50, w: 12, z: -3 }],
      })
    );
    expect(out?.aspectRatio).toBe(5);
    expect(out?.bubbles[0]).toMatchObject({ x: -1, y: 2, w: 1, z: 0 });
  });

  // NaN and Infinity are not clamped: a non-finite number is not "too big", it is not a number,
  // so it falls back like a string would. JSON.parse yields neither, but a hand-built body can.
  it('substitutes defaults for non-numeric geometry', () => {
    const out = sanitizePublishedCarte(
      payload({ bubbles: [{ assoId: 'a1', x: 'left', y: null, w: NaN, z: Infinity }] })
    );
    expect(out?.bubbles[0]).toMatchObject({ x: 0, y: 0, w: 0.1, z: 1 });
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
          { content: '   ', x: 0.1 },
          { content: 'La Vie Asso', x: 0.3, y: 0.05, w: 0.4, size: 0.04, align: 'justify' },
          { content: 'Bienvenue', align: 'right', bold: false },
        ],
      })
    );
    expect(out?.texts).toHaveLength(2);
    expect(out?.texts[0]).toMatchObject({ content: 'La Vie Asso', align: 'center' });
    expect(out?.texts[1]).toMatchObject({ content: 'Bienvenue', align: 'right', bold: false });
  });

  it('truncates a text label instead of serving an unbounded string', () => {
    const out = sanitizePublishedCarte(payload({ texts: [{ content: 'x'.repeat(2000) }] }));
    expect(out?.texts[0].content).toHaveLength(1000);
  });

  it('caps how many elements a single publication can carry', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ assoId: `a${i}` }));
    const manyTexts = Array.from({ length: 300 }, () => ({ content: 'x' }));
    const out = sanitizePublishedCarte(payload({ bubbles: many, texts: manyTexts }));
    expect(out?.bubbles).toHaveLength(400);
    expect(out?.texts).toHaveLength(200);
  });

  it('ignores unknown keys instead of echoing them to anonymous visitors', () => {
    const out = sanitizePublishedCarte(
      payload({
        createdBy: 'admin@example.org',
        secret: 'x',
        bubbles: [{ assoId: 'a1', pii: 'x' }],
      })
    );
    expect(Object.keys(out ?? {}).sort()).toEqual([
      'aspectRatio',
      'background',
      'bubbles',
      'texts',
      'titleColor',
      'version',
    ]);
    expect(out?.bubbles[0]).not.toHaveProperty('pii');
  });
});
