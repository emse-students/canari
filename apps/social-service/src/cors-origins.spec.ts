import { Logger } from '@nestjs/common';
import { buildAllowedOrigins, corsOptions, isEdgeOwnedCorsPath } from './cors-origins';

/** Runs the delegate for one request and returns the options it handed `cors`. */
function optionsFor(url: string, exposed: string[] = []) {
  let out: Record<string, unknown> | undefined;
  corsOptions(buildAllowedOrigins('https://canari.emse.fr'), exposed)(
    { originalUrl: url },
    (err, o) => {
      if (err) throw err;
      out = o as Record<string, unknown>;
    }
  );
  return out as {
    origin: (o: string | undefined, cb: (e: Error | null, allow?: boolean) => void) => void;
    credentials: boolean;
    exposedHeaders?: string[];
  };
}

function verdict(url: string, origin: string): boolean | undefined {
  let allow: boolean | undefined;
  optionsFor(url).origin(origin, (_e, a) => {
    allow = a;
  });
  return allow;
}

describe('CORS denial log', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('does not log a denial on a path the edge nginx answers CORS for', () => {
    expect(verdict('/api/public/associations', 'https://portail-etu.emse.fr')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still logs the same origin on a credentialed route', () => {
    expect(verdict('/api/posts', 'https://portail-etu.emse.fr')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'CORS DENIED origin "https://portail-etu.emse.fr"'
    );
  });

  it('keeps the allowlist verdict and the credentialed options for every path', () => {
    expect(verdict('/api/public/x', 'https://canari.emse.fr')).toBe(true);
    expect(optionsFor('/api/posts', ['X-A']).credentials).toBe(true);
    expect(optionsFor('/api/posts', ['X-A']).exposedHeaders).toEqual(['X-A']);
  });

  it('matches the prefix on a path, not a lookalike', () => {
    expect(isEdgeOwnedCorsPath('/api/public/forms/1?x=1')).toBe(true);
    expect(isEdgeOwnedCorsPath('/api/publicity')).toBe(false);
    expect(isEdgeOwnedCorsPath('/api/media/public/x')).toBe(false);
    expect(isEdgeOwnedCorsPath(undefined)).toBe(false);
  });
});
