import { parseCanariLinkTarget } from './canariLinkPreviewFormat';
import { setLocale } from '$lib/paraglide/runtime';

vi.mock('$lib/forms/api', async (orig) => {
  const actual = await orig<typeof import('$lib/forms/api')>();
  return { ...actual, getForm: vi.fn(), getPublicForm: vi.fn() };
});
vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: vi.fn(async () => 'Camille D'),
  getUserDisplayNameSync: (_id: string, fallback: string) => fallback,
}));
vi.mock('$lib/associations/api', async (orig) => {
  const actual = await orig<typeof import('$lib/associations/api')>();
  return { ...actual, getAssociation: vi.fn(), getAssociationBySlug: vi.fn() };
});

const formsApi = (await import('$lib/forms/api')) as unknown as {
  getForm: ReturnType<typeof vi.fn>;
  getPublicForm: ReturnType<typeof vi.fn>;
  PublicFormUnavailableError: new (notFound: boolean) => Error;
};
const assoApi = (await import('$lib/associations/api')) as unknown as {
  getAssociation: ReturnType<typeof vi.fn>;
  getAssociationBySlug: ReturnType<typeof vi.fn>;
};
const { FormNotFoundError } = await import('$lib/forms/api');
const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
const { fetchCanariLinkPreview, formStateLabel } = await import('./canariLinkPreview');

describe('internal link kinds: the guest form address, lists, and the answers that end in the generic card', () => {
  beforeEach(() => {
    setLocale('fr', { reload: false });
    formsApi.getForm.mockReset();
    formsApi.getPublicForm.mockReset();
    assoApi.getAssociation.mockReset();
    assoApi.getAssociationBySlug.mockReset();
  });

  it('reads /f/<id> and /lists/<slug> as a form and an association', () => {
    expect(parseCanariLinkTarget('https://canari.emse.fr/f/f9')).toEqual({
      kind: 'guest-form',
      formId: 'f9',
    });
    expect(parseCanariLinkTarget('https://canari.emse.fr/lists/promo')).toEqual({
      kind: 'association',
      slug: 'promo',
    });
    // The legacy apex names the same targets.
    expect(parseCanariLinkTarget('https://canari-emse.fr/f/f9')).toEqual({
      kind: 'guest-form',
      formId: 'f9',
    });
  });

  it('draws a form: title, banner, the association and its open state', async () => {
    formsApi.getForm.mockResolvedValue({
      id: 'f1',
      title: 'Soiree BDE',
      description: 'Inscris-toi',
      basePrice: 0,
      currency: 'eur',
      imageUrl: '/api/media/public/banner',
      associationName: 'BDE',
      closedAt: null,
    });
    const preview = await fetchCanariLinkPreview('https://canari.emse.fr/forms/f1');
    expect(preview).toMatchObject({ kind: 'form', title: 'Soiree BDE' });
    expect(preview?.imageUrl).toContain('/api/media/public/banner');
    expect(preview?.subtitle).toBe('Ouvert · BDE - Inscris-toi');
  });

  it('falls back to the association logo when the form has no banner', async () => {
    formsApi.getForm.mockResolvedValue({
      id: 'f2',
      title: 'Cotisation',
      basePrice: 500,
      currency: 'eur',
      associationId: 'a1',
      associationName: 'BDE',
    });
    assoApi.getAssociation.mockResolvedValue({ logoUrl: '/api/media/public/logo' });
    const preview = await fetchCanariLinkPreview('https://canari.emse.fr/forms/f2');
    expect(preview?.imageUrl).toContain('/api/media/public/logo');
  });

  it('says closed for a closed form', async () => {
    formsApi.getForm.mockResolvedValue({
      id: 'f3',
      title: 'Ferme',
      basePrice: 0,
      currency: 'eur',
      closedAt: '2026-01-01T00:00:00Z',
    });
    const preview = await fetchCanariLinkPreview('https://canari.emse.fr/forms/f3');
    expect(preview?.subtitle).toBe('Fermé');
  });

  it('reads a guest link through the guest read when the session is refused', async () => {
    formsApi.getForm.mockRejectedValue(new FormNotFoundError('f4'));
    formsApi.getPublicForm.mockResolvedValue({
      id: 'f4',
      title: 'Public',
      basePrice: 0,
      currency: 'eur',
      formFull: true,
    });
    const preview = await fetchCanariLinkPreview('https://canari.emse.fr/f/f4');
    expect(preview).toMatchObject({ kind: 'form', title: 'Public', subtitle: 'Complet' });
  });

  it('keeps the generic card, and remembers it, when the server answers 404 on both reads', async () => {
    formsApi.getForm.mockRejectedValue(new FormNotFoundError('f5'));
    formsApi.getPublicForm.mockRejectedValue(new formsApi.PublicFormUnavailableError(true));
    const first = await fetchCanariLinkPreview('https://canari.emse.fr/f/f5');
    expect(first).toMatchObject({ kind: 'route', title: 'Formulaire' });
    await fetchCanariLinkPreview('https://canari.emse.fr/f/f5');
    expect(formsApi.getForm).toHaveBeenCalledTimes(1);
  });

  it('answers a 403 with the generic card, cached', async () => {
    assoApi.getAssociationBySlug.mockRejectedValue(new ApiRefusalError(403, null, 'no'));
    const first = await fetchCanariLinkPreview('https://canari.emse.fr/associations/secret');
    expect(first?.kind).toBe('route');
    await fetchCanariLinkPreview('https://canari.emse.fr/associations/secret');
    expect(assoApi.getAssociationBySlug).toHaveBeenCalledTimes(1);
  });

  it('does not remember a transport failure: the next card asks again', async () => {
    assoApi.getAssociationBySlug.mockRejectedValue(new TypeError('Failed to fetch'));
    const first = await fetchCanariLinkPreview('https://canari.emse.fr/associations/flaky');
    expect(first?.kind).toBe('route');
    await fetchCanariLinkPreview('https://canari.emse.fr/associations/flaky');
    expect(assoApi.getAssociationBySlug).toHaveBeenCalledTimes(2);
  });

  it('draws a list as an association and a profile with its avatar', async () => {
    assoApi.getAssociationBySlug.mockResolvedValue({
      name: 'Liste Promo',
      description: 'Une liste',
      logoUrl: null,
    });
    const list = await fetchCanariLinkPreview('https://canari.emse.fr/lists/promo');
    expect(list).toMatchObject({ kind: 'association', title: 'Liste Promo' });
    const profile = await fetchCanariLinkPreview('https://canari.emse.fr/profile/user-9');
    expect(profile?.imageUrl).toContain('/api/users/user-9/avatar');
  });
});

describe('formStateLabel', () => {
  beforeEach(() => setLocale('fr', { reload: false }));
  const NOW = Date.parse('2026-06-01T12:00:00Z');

  it('orders closed, not yet open, full, open', () => {
    expect(formStateLabel({ closedAt: '2026-05-01T00:00:00Z' }, NOW)).toBe('Fermé');
    expect(formStateLabel({ opensAt: '2026-07-01T00:00:00Z' }, NOW)).toMatch(/^Ouvre le /);
    expect(formStateLabel({ formFull: true }, NOW)).toBe('Complet');
    expect(formStateLabel({ opensAt: '2026-05-01T00:00:00Z' }, NOW)).toBe('Ouvert');
  });
});
