import { internalCoreRequestConfig } from './core-request';

describe('internalCoreRequestConfig', () => {
  const saved = process.env.INTERNAL_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = saved;
  });

  it('carries the internal secret core-service checks, and follows no redirect', () => {
    process.env.INTERNAL_SECRET = ' s3cret ';
    expect(internalCoreRequestConfig()).toEqual({
      maxRedirects: 0,
      headers: { 'x-internal-secret': 's3cret' },
    });
  });

  it('sends no header when the secret is unset, so core refuses rather than trusts', () => {
    delete process.env.INTERNAL_SECRET;
    expect(internalCoreRequestConfig().headers).toEqual({});
  });
});
