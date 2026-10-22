import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/pdf/searchableRaster', () => ({ exportSearchablePdf: vi.fn() }));

import { buildTrombinoscopeHtml } from './trombinoscope';
import type { Association, AssociationMember } from '$lib/associations/api';

/**
 * The trombinoscope sheet is a string of markup set as `innerHTML`, so every value it interpolates
 * from the server must stay a value: an attribute cannot be closed and a tag cannot be opened.
 */
function asso(overrides: Partial<Association>): Association {
  return {
    id: 'asso-1',
    name: 'BDE',
    slug: 'bde',
    logoUrl: null,
    contactEmail: null,
    ...overrides,
  } as Association;
}

function member(overrides: Partial<AssociationMember>): AssociationMember {
  return { userId: 'u-1', role: 'Membre', displayName: 'Ana', ...overrides } as AssociationMember;
}

function render(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('buildTrombinoscopeHtml', () => {
  it('keeps a quote inside the logo src', () => {
    const odd = 'https://x.test/a.png" data-extra="1';
    const host = render(buildTrombinoscopeHtml(asso({ logoUrl: odd }), [], {}));
    expect(host.querySelector('[data-extra]')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('src')).toBe(odd);
  });

  it('draws no image for a logo URL with a scheme that is not http(s)', () => {
    const host = render(
      buildTrombinoscopeHtml(asso({ logoUrl: 'javascript:alert(1)', name: 'Club' }), [], {})
    );
    expect(host.querySelector('img')).toBeNull();
  });

  it('absolutizes an own media reference', () => {
    const host = render(
      buildTrombinoscopeHtml(asso({ logoUrl: '/api/media/public/m-1?v=2' }), [], {})
    );
    expect(host.querySelector('img')?.getAttribute('src')).toMatch(
      /^https?:\/\/[^/]+\/api\/media\/public\/m-1\?v=2$/
    );
  });

  it('renders the initials of a markup-like name as text', () => {
    const host = render(
      buildTrombinoscopeHtml(asso({ name: '<b>x' }), [member({ displayName: '<i>y' })], {})
    );
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('i')).toBeNull();
  });
});
